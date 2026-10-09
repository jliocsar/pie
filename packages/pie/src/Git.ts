import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Str from 'effect/String'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type { Repository } from './ConfigRepo.ts'
import { githubUrl, POD_TAG, RECIPE_TAG_PREFIX, RepositoryUnreachable } from './ExeDev.ts'
import {
  cacheHome,
  configHome,
  homeDirectory,
  PRIVATE_DIRECTORY_MODE,
  REGULAR_FILE_MODE,
  writeFileIfChanged,
} from './Pod.ts'

export class ConfigRepositoryUnknown extends Schema.TaggedError<ConfigRepositoryUnknown>()(
  'ConfigRepositoryUnknown',
  {},
) {
  override get message(): string {
    return "pie doesn't know this VM's config repo yet. Run `pie pod up <org>/<repo>` once, and later runs remember it."
  }
}

export class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()('GitCommandFailed', {
  gitArguments: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  gitOutput: Schema.String,
}) {
  override get message(): string {
    return `git ${this.gitArguments.join(' ')} exited with ${this.exitCode}: ${this.gitOutput.trim()}`
  }
}

const rememberedConfigRepositoryPath = Effect.gen(function* () {
  const path = yield* Path.Path

  return path.join(yield* configHome, 'pie', 'config-repo')
})

export const runGit = Effect.fn('runGit')(function* (gitArguments: readonly string[]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const gitProcess = yield* spawner.spawn(
    ChildProcess.make('git', gitArguments, {
      extendEnv: true,
      env: { GIT_TERMINAL_PROMPT: '0' },
      stdin: 'ignore',
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
}, Effect.scoped)

const failAsUnreachable =
  (repositoryName: string, integrationTag: string) => (gitEffect: ReturnType<typeof runGit>) =>
    gitEffect.pipe(
      Effect.catchTag('GitCommandFailed', (gitFailure) =>
        Effect.fail(
          new RepositoryUnreachable({
            repositoryName,
            integrationTag,
            gitOutput: gitFailure.gitOutput,
          }),
        ),
      ),
    )

export const configRepositoryOf = Effect.fn('configRepositoryOf')(function* (
  configRepositoryArgument: Option.Option<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const rememberedPath = yield* rememberedConfigRepositoryPath

  return yield* Option.match(configRepositoryArgument, {
    onSome: Effect.succeed,
    onNone: () =>
      fileSystem.exists(rememberedPath).pipe(
        Effect.filterOrFail(
          (remembered) => remembered,
          () => new ConfigRepositoryUnknown(),
        ),
        Effect.andThen(fileSystem.readFileString(rememberedPath)),
        Effect.map(Str.trim),
      ),
  })
})

export const rememberConfigRepository = Effect.fn('rememberConfigRepository')(function* (
  repositoryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const rememberedPath = yield* rememberedConfigRepositoryPath

  yield* fileSystem.makeDirectory(path.dirname(rememberedPath), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  yield* writeFileIfChanged(
    rememberedPath,
    new TextEncoder().encode(`${repositoryName}\n`),
    REGULAR_FILE_MODE,
  )
})

export const configCheckoutDirectoryOf = Effect.fn('configCheckoutDirectoryOf')(function* (
  repositoryName: string,
) {
  const path = yield* Path.Path

  return path.join(yield* cacheHome, 'pie', repositoryName)
})

export const syncConfigCheckout = Effect.fn('syncConfigCheckout')(function* (
  repositoryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const checkoutDirectory = yield* configCheckoutDirectoryOf(repositoryName)

  if (yield* fileSystem.exists(path.join(checkoutDirectory, '.git'))) {
    yield* runGit(['-C', checkoutDirectory, 'fetch', '--quiet', 'origin']).pipe(
      failAsUnreachable(repositoryName, POD_TAG),
    )
    yield* runGit(['-C', checkoutDirectory, 'reset', '--hard', '--quiet', 'origin/HEAD'])
  } else {
    const githubBaseUrl = yield* githubUrl

    yield* runGit([
      'clone',
      '--quiet',
      `${githubBaseUrl}/${repositoryName}.git`,
      checkoutDirectory,
    ]).pipe(failAsUnreachable(repositoryName, POD_TAG))
  }

  const commit = Str.trim(yield* runGit(['-C', checkoutDirectory, 'rev-parse', 'HEAD']))

  return { checkoutDirectory, commit }
})

export const cloneMissingRepositories = Effect.fn('cloneMissingRepositories')(function* (
  recipeName: string,
  repositories: readonly Repository[],
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workspaceDirectory = path.join(yield* homeDirectory, 'workspace')
  const githubBaseUrl = yield* githubUrl

  yield* Effect.forEach(
    repositories,
    (repository) => {
      const checkoutPath = path.join(workspaceDirectory, repository.dir)

      return runGit([
        'clone',
        '--quiet',
        `${githubBaseUrl}/${repository.repo}.git`,
        checkoutPath,
      ]).pipe(
        failAsUnreachable(repository.repo, `${RECIPE_TAG_PREFIX}${recipeName}`),
        Effect.when(Effect.map(fileSystem.exists(checkoutPath), (cloned) => !cloned)),
      )
    },
    { discard: true },
  )
})
