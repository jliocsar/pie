import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import {
  applyClaudeConfig,
  claudeConfigOf,
  failOnForeignClaudeConfig,
  readClaudeState,
} from '../Claude.ts'
import { configFilePathOf, loadConfig } from '../ConfigRepo.ts'
import { recipeNameOfThisVm } from '../ExeDev.ts'
import {
  cloneMissingRepositories,
  configRepositoryOf,
  rememberConfigRepository,
  syncConfigCheckout,
} from '../Git.ts'
import { installTools, runTasks } from '../Mise.ts'
import {
  applyHomeFiles,
  failOnForeignHomeFiles,
  homeFilesOf,
  readHomeManifest,
  readPodFile,
} from '../Pod.ts'

const COMMIT_ABBREVIATION_LENGTH = 7

export class RecipeNotFound extends Schema.TaggedError<RecipeNotFound>()('RecipeNotFound', {
  recipeName: Schema.String,
}) {
  override get message(): string {
    return `This VM is tagged for recipe ${this.recipeName}, but ${configFilePathOf.recipe(this.recipeName)} doesn't exist in the config repo.`
  }
}

export const pod = Command.make('pod').pipe(
  Command.withDescription('Commands that run on a pod, the exe.dev VM a recipe sets up.'),
  Command.withSubcommands([
    Command.make(
      'up',
      { configRepository: Argument.String('org/repo').pipe(Argument.optional) },
      Effect.fn(function* ({ configRepository }) {
        const repositoryName = yield* configRepositoryOf(configRepository)
        const recipeName = yield* recipeNameOfThisVm
        const { checkoutDirectory, commit } = yield* syncConfigCheckout(repositoryName)

        yield* rememberConfigRepository(repositoryName)

        const config = yield* loadConfig(checkoutDirectory)
        const recipe = yield* Option.match(Record.get(config.recipes, recipeName), {
          onNone: () => Effect.fail(new RecipeNotFound({ recipeName })),
          onSome: Effect.succeed,
        })
        const tasks = yield* Effect.forEach(recipe.environment.tasks, (taskName) =>
          readPodFile(checkoutDirectory, configFilePathOf.task(taskName), taskName),
        )
        const claudeConfig = yield* claudeConfigOf(checkoutDirectory, recipe)
        const claudeState = yield* readClaudeState()
        const homeFiles = yield* homeFilesOf(checkoutDirectory, recipe)
        const previousHomeManifest = yield* readHomeManifest()

        yield* failOnForeignClaudeConfig(claudeConfig, claudeState)
        yield* failOnForeignHomeFiles(homeFiles, previousHomeManifest)
        yield* installTools(recipe.environment)
        yield* applyHomeFiles(homeFiles, previousHomeManifest)
        yield* runTasks(tasks)
        yield* cloneMissingRepositories(recipeName, recipe.repositories)
        yield* applyClaudeConfig(claudeConfig, claudeState)
        yield* Console.log(
          `Applied recipe ${recipeName} at config commit ${commit.slice(0, COMMIT_ABBREVIATION_LENGTH)}.`,
        )
      }),
    ).pipe(
      Command.withDescription(
        "Apply this VM's recipe, named by its pie-recipe-<name> tag, from the config repo. The first run needs <org/repo>; later runs remember it.",
      ),
    ),
  ]),
)
