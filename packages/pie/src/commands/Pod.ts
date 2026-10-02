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
import { readPodFile } from '../Pod.ts'

const COMMIT_ABBREVIATION_LENGTH = 7

export class RecipeNotFound extends Schema.TaggedError<RecipeNotFound>()('RecipeNotFound', {
  recipeName: Schema.String,
}) {
  override get message(): string {
    return `This VM is tagged for recipe ${this.recipeName}, but ${configFilePathOf.recipe(this.recipeName)} doesn't exist in the config repo.`
  }
}

export const pod = Command.make('pod').pipe(
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

        yield* failOnForeignClaudeConfig(claudeConfig, claudeState)
        yield* installTools(recipe.environment)
        yield* runTasks(tasks)
        yield* cloneMissingRepositories(recipeName, recipe.repositories)
        yield* applyClaudeConfig(claudeConfig, claudeState)
        yield* Console.log(
          `Applied recipe ${recipeName} at config commit ${commit.slice(0, COMMIT_ABBREVIATION_LENGTH)}.`,
        )
      }),
    ),
  ]),
)
