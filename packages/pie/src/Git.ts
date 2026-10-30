import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import { type Repository, RepositoryName } from './ConfigRepo.ts'
import {
  ExeDev,
  GITHUB_INTEGRATION,
  POD_TAG,
  RECIPE_TAG_PREFIX,
  type RecipeName,
} from './ExeDev.ts'
import { Box, PRIVATE_DIRECTORY_MODE, REGULAR_FILE_MODE } from './Pod.ts'
import { Process } from './Process.ts'

const GIT_ENVIRONMENT = { GIT_TERMINAL_PROMPT: '0' }

export class ConfigRepositoryUnknown extends Schema.TaggedError<ConfigRepositoryUnknown>()(
  'ConfigRepositoryUnknown',
  {},
) {
  override get message(): string {
    return "pie doesn't know this VM's config repo yet. Run `pie pod up <org>/<repo>` once, and later runs remember it."
  }
}

export class RememberedConfigRepositoryInvalid extends Schema.TaggedError<RememberedConfigRepositoryInvalid>()(
  'RememberedConfigRepositoryInvalid',
  { filePath: Schema.String, rememberedText: Schema.String },
) {
  override get message(): string {
    return `${this.filePath} holds "${this.rememberedText}", which isn't an <org>/<repo> config repo. Run \`pie pod up <org>/<repo>\` to replace it.`
  }
}

export class RepositoryUnreachable extends Schema.TaggedError<RepositoryUnreachable>()(
  'RepositoryUnreachable',
  {
    repositoryName: Schema.String,
    integrationName: Schema.String,
    integrationTag: Schema.String,
    gitOutput: Schema.String,
  },
) {
  override get message(): string {
    const fix =
      this.integrationName === GITHUB_INTEGRATION
        ? `In exe.dev, attach a GitHub integration that reaches it to tag:${this.integrationTag}.`
        : `In exe.dev, check that the ${this.integrationName} integration is attached to tag:${this.integrationTag} and that its token can read the repository.`

    return `pie couldn't reach ${this.repositoryName} through exe.dev's ${this.integrationName} integration. ${fix} git said: ${this.gitOutput.trim()}`
  }
}

const rememberedConfigRepositoryPath = Effect.gen(function* () {
  const path = yield* Path.Path
  const box = yield* Box

  return path.join(box.paths.pieConfigDirectory, 'config-repo')
})

const runGit = Effect.fn('runGit')(function* (gitArguments: readonly string[]) {
  const processes = yield* Process

  return yield* processes.capture(['git', ...gitArguments], GIT_ENVIRONMENT)
})

const failAsUnreachable =
  (route: { repositoryName: string; integrationName: string; integrationTag: string }) =>
  (gitEffect: ReturnType<typeof runGit>) =>
    gitEffect.pipe(
      Effect.catchTag('CommandFailed', (gitFailure) =>
        Effect.fail(new RepositoryUnreachable({ ...route, gitOutput: gitFailure.commandOutput })),
      ),
    )

export const configRepositoryOf = Effect.fn('configRepositoryOf')(function* (
  configRepositoryArgument: Option.Option<RepositoryName>,
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
        Effect.flatMap((rememberedText) =>
          Schema.decodeEffect(RepositoryName)(rememberedText).pipe(
            Effect.catchTag('SchemaError', () =>
              Effect.fail(
                new RememberedConfigRepositoryInvalid({ filePath: rememberedPath, rememberedText }),
              ),
            ),
          ),
        ),
      ),
  })
})

export const rememberConfigRepository = Effect.fn('rememberConfigRepository')(function* (
  repositoryName: RepositoryName,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const box = yield* Box
  const rememberedPath = yield* rememberedConfigRepositoryPath

  yield* fileSystem.makeDirectory(path.dirname(rememberedPath), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  yield* box.writeFileIfChanged(rememberedPath, `${repositoryName}\n`, REGULAR_FILE_MODE)
})

export const syncConfigCheckout = Effect.fn('syncConfigCheckout')(function* (
  repositoryName: RepositoryName,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const box = yield* Box
  const checkoutDirectory = path.join(box.paths.pieCacheDirectory, repositoryName)

  const route = { repositoryName, integrationName: GITHUB_INTEGRATION, integrationTag: POD_TAG }

  if (yield* fileSystem.exists(path.join(checkoutDirectory, '.git'))) {
    yield* runGit(['-C', checkoutDirectory, 'fetch', '--quiet', 'origin']).pipe(
      failAsUnreachable(route),
    )
    yield* runGit(['-C', checkoutDirectory, 'reset', '--hard', '--quiet', 'origin/HEAD'])
  } else {
    const githubBaseUrl = (yield* ExeDev).integrationUrl(GITHUB_INTEGRATION)

    yield* runGit([
      'clone',
      '--quiet',
      `${githubBaseUrl}/${repositoryName}.git`,
      checkoutDirectory,
    ]).pipe(failAsUnreachable(route))
  }

  const commit = Str.trim(yield* runGit(['-C', checkoutDirectory, 'rev-parse', 'HEAD']))

  return { checkoutDirectory, commit }
})

export const cloneMissingRepositories = Effect.fn('cloneMissingRepositories')(function* (
  recipeName: RecipeName,
  repositories: readonly Repository[],
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const box = yield* Box
  const exeDev = yield* ExeDev
  const workspaceDirectory = box.paths.workspace

  yield* Effect.forEach(
    repositories,
    (repository) => {
      const checkoutPath = path.join(workspaceDirectory, repository.dir)

      return runGit([
        'clone',
        '--quiet',
        `${exeDev.integrationUrl(repository.integration)}/${repository.repo}.git`,
        checkoutPath,
      ]).pipe(
        failAsUnreachable({
          repositoryName: repository.repo,
          integrationName: repository.integration,
          integrationTag: `${RECIPE_TAG_PREFIX}${recipeName}`,
        }),
        Effect.when(Effect.map(fileSystem.exists(checkoutPath), (cloned) => !cloned)),
      )
    },
    { discard: true },
  )
})
