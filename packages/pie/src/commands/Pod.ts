import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { Claude, claudeConfigOf } from '../Claude.ts'
import { ConfigRepo, configFilePathOf, RepositoryName } from '../ConfigRepo.ts'
import { ExeDev, RecipeName, recipeNameOf } from '../ExeDev.ts'
import { Git } from '../Git.ts'
import { Mise } from '../Mise.ts'
import { Box } from '../Box.ts'
import { HomeSets } from '../HomeSets.ts'
import { Process } from '../Process.ts'

const COMMIT_ABBREVIATION_LENGTH = 7

const ExeDevLayer = ExeDev.layer.pipe(Layer.provide(FetchHttpClient.layer))

const LeafServicesLayer = Layer.mergeAll(ConfigRepo.layer, Box.layer, Process.layer)

const ExeDevAndMiseLayer = Layer.mergeAll(ExeDevLayer, Mise.layer).pipe(
  Layer.provideMerge(LeafServicesLayer),
)

const PodLayer = Layer.mergeAll(Git.layer, Claude.layer, HomeSets.layer).pipe(
  Layer.provideMerge(ExeDevAndMiseLayer),
)

export class RecipeNotFound extends Schema.TaggedError<RecipeNotFound>()('RecipeNotFound', {
  recipeName: RecipeName,
}) {
  override get message(): string {
    return `This VM is tagged for recipe ${this.recipeName}, but ${configFilePathOf('recipe', this.recipeName)} doesn't exist in the config repo.`
  }
}

export const pod = Command.make('pod').pipe(
  Command.withDescription('Commands that run on a pod, the exe.dev VM a recipe sets up.'),
  Command.withSubcommands([
    Command.make(
      'up',
      {
        configRepository: Argument.String('org/repo').pipe(
          Argument.withSchema(RepositoryName),
          Argument.optional,
        ),
      },
      Effect.fn(function* ({ configRepository }) {
        const configRepo = yield* ConfigRepo
        const exeDev = yield* ExeDev
        const git = yield* Git
        const mise = yield* Mise
        const claude = yield* Claude
        const homeSets = yield* HomeSets
        const repositoryName = yield* git.configRepository(configRepository)
        const vmTags = yield* exeDev.vmTags()
        const recipeName = yield* recipeNameOf(vmTags)
        const { checkoutDirectory, commit } = yield* git.syncConfigCheckout(repositoryName)
        const config = yield* configRepo.load(checkoutDirectory)
        const recipe = yield* Effect.fromOption(
          Record.get(config.recipes, recipeName),
          () => new RecipeNotFound({ recipeName }),
        )

        yield* exeDev.requireRecipeTags(recipeName, recipe.tags, vmTags)

        const claudeConfig = claudeConfigOf(recipe)
        const claudeState = yield* claude.readState()
        const previousHomeManifest = yield* homeSets.readManifest()

        yield* claude.failOnForeign(claudeConfig, claudeState)
        yield* homeSets.failOnForeign(recipe.home, previousHomeManifest)
        yield* mise.install(recipe.environment)
        yield* homeSets.apply(recipe.home, previousHomeManifest)
        yield* mise.runTasks(recipe.tasks)
        yield* git.cloneMissingRepositories(recipeName, recipe.repositories)
        yield* claude.apply(claudeConfig, claudeState)
        yield* claude.writeInstructions(recipeName, repositoryName, recipe.claude.claude_md)
        yield* Console.log(
          `Applied recipe ${recipeName} at config commit ${commit.slice(0, COMMIT_ABBREVIATION_LENGTH)}.`,
        )
      }),
    ).pipe(
      Command.provide(PodLayer),
      Command.withDescription(
        "Apply this VM's recipe, named by its pie-recipe-<name> tag, from the config repo. The first run needs <org/repo>; later runs remember it.",
      ),
    ),
  ]),
)
