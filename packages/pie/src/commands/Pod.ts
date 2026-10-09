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
  writeClaudeInstructions,
} from '../Claude.ts'
import { configFilePathOf, loadConfig, type Routine } from '../ConfigRepo.ts'
import { writeRoutineSchedule } from '../Crontab.ts'
import { podTagsOfThisVm, RECIPE_TAG_PREFIX, ROUTINE_TAG_PREFIX } from '../ExeDev.ts'
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

export class RoutineNotFound extends Schema.TaggedError<RoutineNotFound>()('RoutineNotFound', {
  routineName: Schema.String,
}) {
  override get message(): string {
    return `${configFilePathOf.routine(this.routineName)} doesn't exist in the config repo. Add it, or remove this VM's tag with \`ssh exe.dev tag -d <vm> ${ROUTINE_TAG_PREFIX}${this.routineName}\`.`
  }
}

export class RoutineRecipeMismatch extends Schema.TaggedError<RoutineRecipeMismatch>()(
  'RoutineRecipeMismatch',
  { routineName: Schema.String, routineRecipeName: Schema.String, vmRecipeName: Schema.String },
) {
  override get message(): string {
    return `${configFilePathOf.routine(this.routineName)} runs on recipe ${this.routineRecipeName}, but this VM is tagged ${RECIPE_TAG_PREFIX}${this.vmRecipeName}. Retag the VM ${RECIPE_TAG_PREFIX}${this.routineRecipeName}, or change the routine's recipe.`
  }
}

const routineOfThisVm = Effect.fn('routineOfThisVm')(function* (
  routines: Record.ReadonlyRecord<string, Routine>,
  recipeName: string,
  routineName: string,
) {
  const routine = yield* Option.match(Record.get(routines, routineName), {
    onNone: () => Effect.fail(new RoutineNotFound({ routineName })),
    onSome: Effect.succeed,
  })

  if (routine.recipe !== recipeName) {
    return yield* new RoutineRecipeMismatch({
      routineName,
      routineRecipeName: routine.recipe,
      vmRecipeName: recipeName,
    })
  }

  return [routineName, routine] as const
})

const routinesOfThisVm = Effect.fn('routinesOfThisVm')(function* (
  routines: Record.ReadonlyRecord<string, Routine>,
  recipeName: string,
  routineNames: readonly string[],
) {
  return Record.fromEntries(
    yield* Effect.forEach(routineNames, (routineName) =>
      routineOfThisVm(routines, recipeName, routineName),
    ),
  )
})

export const pod = Command.make('pod').pipe(
  Command.withDescription('Commands that run on a pod, the exe.dev VM a recipe sets up.'),
  Command.withSubcommands([
    Command.make(
      'up',
      { configRepository: Argument.String('org/repo').pipe(Argument.optional) },
      Effect.fn(function* ({ configRepository }) {
        const repositoryName = yield* configRepositoryOf(configRepository)
        const { recipeName, routineNames } = yield* podTagsOfThisVm
        const { checkoutDirectory, commit } = yield* syncConfigCheckout(repositoryName)

        yield* rememberConfigRepository(repositoryName)

        const config = yield* loadConfig(checkoutDirectory)
        const recipe = yield* Option.match(Record.get(config.recipes, recipeName), {
          onNone: () => Effect.fail(new RecipeNotFound({ recipeName })),
          onSome: Effect.succeed,
        })
        const routines = yield* routinesOfThisVm(config.routines, recipeName, routineNames)
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
        yield* writeClaudeInstructions(recipeName, repositoryName)
        yield* writeRoutineSchedule(routines)
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
