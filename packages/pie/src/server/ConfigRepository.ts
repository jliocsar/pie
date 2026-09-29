import * as Context from 'effect/Context'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import type { PlatformError } from 'effect/PlatformError'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import * as Str from 'effect/String'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { RecipeNotFound } from '../Api.ts'

const CONFIG_CHECKOUT_DIRECTORY_NAME = 'config'

const GIT_TIMEOUT = Duration.seconds(10)

export class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()('GitCommandFailed', {
  gitArguments: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  gitOutput: Schema.String,
}) {
  override get message(): string {
    return `git ${this.gitArguments.join(' ')} exited with ${this.exitCode}: ${this.gitOutput.trim()}`
  }
}

export class GitCommandTimedOut extends Schema.TaggedError<GitCommandTimedOut>()(
  'GitCommandTimedOut',
  { gitArguments: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `git ${this.gitArguments.join(' ')} took longer than ${Duration.format(GIT_TIMEOUT)}.`
  }
}

export const runGit = Effect.fn('runGit')(
  function* (gitArguments: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const gitProcess = yield* spawner.spawn(
      ChildProcess.make('git', gitArguments, {
        extendEnv: true,
        env: { GIT_TERMINAL_PROMPT: '0' },
      }),
    )
    const [gitOutput, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(gitProcess.all)), gitProcess.exitCode],
      { concurrency: 'unbounded' },
    )

    if (exitCode === 0) {
      return gitOutput
    }

    return yield* new GitCommandFailed({ gitArguments, exitCode, gitOutput })
  },
  Effect.scoped,
  (gitCommand, gitArguments) =>
    Effect.timeoutOrElse(gitCommand, {
      duration: GIT_TIMEOUT,
      orElse: () => Effect.fail(new GitCommandTimedOut({ gitArguments })),
    }),
)

export class ConfigRepository extends Context.Service<
  ConfigRepository,
  {
    readonly checkoutDirectory: string
    readonly pull: Effect.Effect<string, GitCommandFailed | GitCommandTimedOut | PlatformError>
    readonly headCommit: Effect.Effect<
      string,
      GitCommandFailed | GitCommandTimedOut | PlatformError
    >
    readonly failWhenRecipeMissing: (
      recipeName: string,
    ) => Effect.Effect<void, RecipeNotFound | PlatformError>
  }
>()('pie/ConfigRepository') {
  static readonly layer = (dataDirectory: string, configRepositoryUrl: string) =>
    Layer.effect(
      ConfigRepository,
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const checkoutDirectory = path.join(dataDirectory, CONFIG_CHECKOUT_DIRECTORY_NAME)
        const alreadyCloned = yield* fileSystem.exists(path.join(checkoutDirectory, '.git'))
        const pullPermit = yield* Semaphore.make(1)
        const runGitInCheckout = (gitArguments: readonly string[]) =>
          runGit(['-C', checkoutDirectory, ...gitArguments]).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          )

        yield* runGit(['clone', '--quiet', configRepositoryUrl, checkoutDirectory]).pipe(
          Effect.when(Effect.succeed(!alreadyCloned)),
        )

        return ConfigRepository.of({
          checkoutDirectory,
          pull: runGitInCheckout(['pull', '--ff-only', '--quiet']).pipe(
            Semaphore.withPermits(pullPermit, 1),
          ),
          headCommit: runGitInCheckout(['rev-parse', 'HEAD']).pipe(Effect.map(Str.trim)),
          failWhenRecipeMissing: (recipeName) =>
            fileSystem
              .exists(path.join(checkoutDirectory, 'recipes', `${recipeName}.toml`))
              .pipe(
                Effect.flatMap((recipeExists) =>
                  recipeExists ? Effect.void : Effect.fail(new RecipeNotFound({ recipeName })),
                ),
              ),
        })
      }),
    )
}
