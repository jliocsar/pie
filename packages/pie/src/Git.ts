import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
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

interface GitRoute {
  readonly repositoryName: string
  readonly integrationName: string
  readonly integrationTag: string
}

const REMEMBERED_CONFIG_REPOSITORY_FILE_NAME = 'config-repo'
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

export class Git extends Context.Service<Git>()('pie/Git', {
  make: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const processes = yield* Process
    const box = yield* Box
    const exeDev = yield* ExeDev
    const rememberedPath = path.join(
      box.paths.pieConfigDirectory,
      REMEMBERED_CONFIG_REPOSITORY_FILE_NAME,
    )

    const runGit = (gitArguments: readonly string[]) =>
      processes.capture(['git', ...gitArguments], GIT_ENVIRONMENT)

    const failAsUnreachable = (route: GitRoute) => (gitEffect: ReturnType<typeof runGit>) =>
      gitEffect.pipe(
        Effect.catchTag('CommandFailed', (gitFailure) =>
          Effect.fail(new RepositoryUnreachable({ ...route, gitOutput: gitFailure.commandOutput })),
        ),
      )

    const configRepository = Effect.fn('Git.configRepository')(function* (
      configRepositoryArgument: Option.Option<RepositoryName>,
    ) {
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
                    new RememberedConfigRepositoryInvalid({
                      filePath: rememberedPath,
                      rememberedText,
                    }),
                  ),
                ),
              ),
            ),
          ),
      })
    })

    const remember = Effect.fn('Git.remember')(function* (repositoryName: RepositoryName) {
      yield* fileSystem.makeDirectory(path.dirname(rememberedPath), {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      })
      yield* box.writeFileIfChanged(rememberedPath, `${repositoryName}\n`, REGULAR_FILE_MODE)
    })

    const syncConfigCheckout = Effect.fn('Git.syncConfigCheckout')(function* (
      repositoryName: RepositoryName,
    ) {
      const checkoutDirectory = path.join(box.paths.pieCacheDirectory, repositoryName)
      const route = {
        repositoryName,
        integrationName: GITHUB_INTEGRATION,
        integrationTag: POD_TAG,
      }

      if (yield* fileSystem.exists(path.join(checkoutDirectory, '.git'))) {
        yield* runGit(['-C', checkoutDirectory, 'fetch', '--quiet', 'origin']).pipe(
          failAsUnreachable(route),
        )
        yield* runGit(['-C', checkoutDirectory, 'reset', '--hard', '--quiet', 'origin/HEAD'])
      } else {
        yield* runGit([
          'clone',
          '--quiet',
          `${exeDev.integrationUrl(GITHUB_INTEGRATION)}/${repositoryName}.git`,
          checkoutDirectory,
        ]).pipe(failAsUnreachable(route))
      }

      const commit = Str.trim(yield* runGit(['-C', checkoutDirectory, 'rev-parse', 'HEAD']))

      return { checkoutDirectory, commit }
    })

    const cloneWhenMissing = Effect.fn('Git.cloneWhenMissing')(function* (
      recipeName: RecipeName,
      repository: Repository,
    ) {
      const checkoutPath = path.join(box.paths.workspace, repository.dir)

      if (yield* fileSystem.exists(checkoutPath)) {
        return
      }

      yield* runGit([
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
      )
    })

    const cloneMissingRepositories = Effect.fn('Git.cloneMissingRepositories')(function* (
      recipeName: RecipeName,
      repositories: readonly Repository[],
    ) {
      yield* Effect.forEach(
        repositories,
        (repository) => cloneWhenMissing(recipeName, repository),
        { discard: true },
      )
    })

    return { configRepository, remember, syncConfigCheckout, cloneMissingRepositories }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Process.layer, Box.layer, ExeDev.layer)),
  )
}
