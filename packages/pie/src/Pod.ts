import * as Arr from 'effect/Array'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Str from 'effect/String'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import {
  configFilePathOf,
  ConfigReferenceMissing,
  type Environment,
  HttpMcpServer,
  listDirectory,
  loadConfig,
  type McpServer,
  type ReferenceKind,
  type ToolRequest,
} from './Config.ts'
import { recipeNameOfThisVm } from './Reflection.ts'

const REGULAR_FILE_MODE = 0o644

const EXECUTABLE_FILE_MODE = 0o755

const PERMISSION_BITS = 0o777

const PRIVATE_DIRECTORY_MODE = 0o700

const CLAUDE_ENTRY_SEGMENT_COUNT = 2

const MISE_INSTALLER_URL = 'https://mise.run'

const MISE_SHIMS_PATH_LINE = 'export PATH="$HOME/.local/share/mise/shims:$PATH"'

const MISE_TOOLS_TABLE = '[tools]'

const EXECUTABLE_MODE_BITS = 0o111

const DEFAULT_GITHUB_URL = 'https://github.int.exe.xyz'

export const ClaudeMcpServer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('http'), url: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('stdio'),
    command: Schema.String,
    args: Schema.Array(Schema.String),
  }),
])

export type ClaudeMcpServer = typeof ClaudeMcpServer.Type

const Manifest = Schema.Struct({
  claudeFiles: Schema.Array(Schema.String),
  mcpServers: Schema.Record(Schema.String, ClaudeMcpServer),
})

type Manifest = typeof Manifest.Type

const ManifestJson = Schema.fromJsonString(Manifest)

const EMPTY_MANIFEST: Manifest = { claudeFiles: [], mcpServers: {} }

const ClaudeStateJson = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

const isSameMcpServer = Schema.toEquivalence(ClaudeMcpServer)

export class ClaudeEntryNotPies extends Schema.TaggedError<ClaudeEntryNotPies>()(
  'ClaudeEntryNotPies',
  { entryPath: Schema.String },
) {
  override get message(): string {
    return `${this.entryPath} already exists, and pie didn't write it. Move it out of the way, then run \`pie pod up\` again.`
  }
}

export class McpServerNotPies extends Schema.TaggedError<McpServerNotPies>()('McpServerNotPies', {
  mcpName: Schema.String,
}) {
  override get message(): string {
    return `Claude already has a user MCP server named ${this.mcpName}, and pie didn't add it. Remove it with \`claude mcp remove --scope user ${this.mcpName}\`, then run \`pie pod up\` again.`
  }
}

export class PodFileUnreadable extends Schema.TaggedError<PodFileUnreadable>()(
  'PodFileUnreadable',
  { filePath: Schema.String, issueMessage: Schema.String },
) {
  override get message(): string {
    return `${this.filePath} isn't the JSON pie expected: ${this.issueMessage}`
  }
}

export class RecipeNotFound extends Schema.TaggedError<RecipeNotFound>()('RecipeNotFound', {
  recipeName: Schema.String,
}) {
  override get message(): string {
    return `This VM is tagged for recipe ${this.recipeName}, but ${configFilePathOf.recipe(this.recipeName)} doesn't exist in the config repo.`
  }
}

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

export class CommandFailed extends Schema.TaggedError<CommandFailed>()('CommandFailed', {
  commandLine: Schema.Array(Schema.String),
  exitCode: Schema.Int,
}) {
  override get message(): string {
    return `\`${this.commandLine.join(' ')}\` exited with ${this.exitCode}.`
  }
}

export const configHome = Config.String('XDG_CONFIG_HOME').pipe(
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.config`))),
)

const cacheHome = Config.String('XDG_CACHE_HOME').pipe(
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.cache`))),
)

const githubUrl = Config.String('PIE_GITHUB_URL').pipe(Config.withDefault(DEFAULT_GITHUB_URL))

const podPaths = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* Config.String('HOME')
  const configDirectory = yield* configHome

  return {
    home,
    githubUrl: yield* githubUrl,
    configCheckoutsDirectory: path.join(yield* cacheHome, 'pie'),
    configRepositoryPath: path.join(configDirectory, 'pie', 'config-repo'),
    claudeDirectory: path.join(home, '.claude'),
    claudeStatePath: path.join(home, '.claude.json'),
    manifestPath: path.join(configDirectory, 'pie', 'manifest.json'),
    misePath: path.join(home, '.local', 'bin', 'mise'),
    miseConfigPath: path.join(configDirectory, 'mise', 'conf.d', 'pie.toml'),
    shellStartupPaths: [path.join(home, '.profile'), path.join(home, '.zshrc')],
    workspaceDirectory: path.join(home, 'workspace'),
  }
})

type PodPaths = Effect.Success<typeof podPaths>

type PodConfig = Effect.Success<ReturnType<typeof podConfigOf>>

const decodeJsonFile = <Decoded>(schema: Schema.Codec<Decoded, string>) =>
  Effect.fn('decodeJsonFile')(function* (filePath: string, fallback: Decoded) {
    const fileSystem = yield* FileSystem.FileSystem

    if (!(yield* fileSystem.exists(filePath))) {
      return fallback
    }

    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(Schema.decodeEffect(schema)),
      Effect.catchTag('SchemaError', (schemaError) =>
        Effect.fail(new PodFileUnreadable({ filePath, issueMessage: schemaError.message })),
      ),
    )
  })

const readManifest = decodeJsonFile(ManifestJson)

const readClaudeMcpNames = (claudeStatePath: string) =>
  decodeJsonFile(ClaudeStateJson)(claudeStatePath, {}).pipe(
    Effect.map((claudeState) => Record.keys(claudeState.mcpServers ?? {})),
  )

const writeManifest = Effect.fn('writeManifest')(function* (
  manifestPath: string,
  manifest: Manifest,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const temporaryManifestPath = `${manifestPath}.tmp`
  const manifestText = yield* Schema.encodeEffect(ManifestJson)(manifest)
  const unchanged =
    (yield* fileSystem.exists(manifestPath)) &&
    (yield* fileSystem.readFileString(manifestPath)) === manifestText

  if (unchanged) {
    return
  }

  yield* fileSystem.makeDirectory(path.dirname(manifestPath), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  yield* fileSystem.writeFileString(temporaryManifestPath, manifestText)
  yield* fileSystem.rename(temporaryManifestPath, manifestPath)
})

export const runCommand = Effect.fn('runCommand')(function* (
  commandLine: readonly [string, ...string[]],
  home: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const [command, ...commandArguments] = commandLine
  yield* spawner
    .exitCode(
      ChildProcess.make(command, commandArguments, {
        cwd: home,
        extendEnv: true,
        env: { HOME: home },
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    )
    .pipe(
      Effect.filterOrFail(
        (exitCode) => exitCode === 0,
        (exitCode) => new CommandFailed({ commandLine, exitCode }),
      ),
    )
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

const configRepositoryOf = Effect.fn('configRepositoryOf')(function* (
  paths: PodPaths,
  configRepositoryArgument: Option.Option<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem

  return yield* Option.match(configRepositoryArgument, {
    onSome: Effect.succeed,
    onNone: () =>
      fileSystem.exists(paths.configRepositoryPath).pipe(
        Effect.filterOrFail(
          (remembered) => remembered,
          () => new ConfigRepositoryUnknown(),
        ),
        Effect.andThen(fileSystem.readFileString(paths.configRepositoryPath)),
        Effect.map(Str.trim),
      ),
  })
})

const rememberConfigRepository = Effect.fn('rememberConfigRepository')(function* (
  paths: PodPaths,
  repositoryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* fileSystem.makeDirectory(path.dirname(paths.configRepositoryPath), {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  yield* writeFileIfChanged(
    paths.configRepositoryPath,
    new TextEncoder().encode(`${repositoryName}\n`),
    REGULAR_FILE_MODE,
  )
})

const syncConfigCheckout = Effect.fn('syncConfigCheckout')(function* (
  paths: PodPaths,
  repositoryName: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const checkoutDirectory = path.join(paths.configCheckoutsDirectory, repositoryName)

  if (yield* fileSystem.exists(path.join(checkoutDirectory, '.git'))) {
    yield* runGit(['-C', checkoutDirectory, 'fetch', '--quiet', 'origin'])
    yield* runGit(['-C', checkoutDirectory, 'reset', '--hard', '--quiet', 'origin/HEAD'])
  } else {
    yield* runGit([
      'clone',
      '--quiet',
      `${paths.githubUrl}/${repositoryName}.git`,
      checkoutDirectory,
    ])
  }

  const commit = Str.trim(yield* runGit(['-C', checkoutDirectory, 'rev-parse', 'HEAD']))

  return { checkoutDirectory, commit }
})

const tomlInlineTableOf = (toolRequest: ToolRequest) =>
  `{ ${Arr.map(
    Record.toEntries(toolRequest),
    ([optionName, optionValue]) => `${JSON.stringify(optionName)} = ${JSON.stringify(optionValue)}`,
  ).join(', ')} }`

const miseConfigOf = (environment: Environment) =>
  [
    MISE_TOOLS_TABLE,
    ...Arr.map(
      Record.toEntries(environment.tools),
      ([toolName, toolRequest]) =>
        `${JSON.stringify(toolName)} = ${tomlInlineTableOf(toolRequest)}`,
    ),
    '',
  ].join('\n')

const isHttpMcpServer = Schema.is(HttpMcpServer)

const claudeMcpServerOf = (mcpServer: McpServer): ClaudeMcpServer =>
  isHttpMcpServer(mcpServer)
    ? { type: 'http', url: mcpServer.url }
    : { type: 'stdio', command: mcpServer.command, args: mcpServer.args }

const lookUpRecipeReference = <Value>(
  recipeName: string,
  referenceKind: ReferenceKind,
  entries: Record.ReadonlyRecord<string, Value>,
  referenceName: string,
): Effect.Effect<Value, ConfigReferenceMissing> =>
  Option.match(Record.get(entries, referenceName), {
    onNone: () =>
      Effect.fail(
        new ConfigReferenceMissing({
          filePath: configFilePathOf.recipe(recipeName),
          referenceKind,
          referenceName,
        }),
      ),
    onSome: Effect.succeed,
  })

const readPodFile = Effect.fn('readPodFile')(function* (
  configDirectory: string,
  filePath: string,
  podPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absoluteFilePath = path.join(configDirectory, filePath)
  const content = yield* fileSystem.readFile(absoluteFilePath)
  const fileInfo = yield* fileSystem.stat(absoluteFilePath)

  return { path: podPath, content, executable: (fileInfo.mode & EXECUTABLE_MODE_BITS) !== 0 }
})

const readRepositoryFile = (configDirectory: string, filePath: string) =>
  readPodFile(configDirectory, filePath, filePath)

const readSkillFiles = Effect.fn('readSkillFiles')(function* (
  configDirectory: string,
  skillName: string,
) {
  const path = yield* Path.Path
  const skillDirectory = path.dirname(configFilePathOf.skill(skillName))
  const skillFilePaths = yield* listDirectory(configDirectory, skillDirectory, 'File', {
    recursive: true,
  })

  return yield* Effect.forEach(skillFilePaths, (skillFilePath) =>
    readRepositoryFile(configDirectory, path.join(skillDirectory, skillFilePath)),
  )
})

const podConfigOf = Effect.fn('podConfigOf')(function* (
  configDirectory: string,
  recipeName: string,
  commit: string,
) {
  const config = yield* loadConfig(configDirectory)
  const recipe = yield* Option.match(Record.get(config.recipes, recipeName), {
    onNone: () => Effect.fail(new RecipeNotFound({ recipeName })),
    onSome: Effect.succeed,
  })
  const environment = yield* lookUpRecipeReference(
    recipeName,
    'environment',
    config.environments,
    recipe.environment,
  )
  const mcpServerEntries = yield* Effect.forEach(recipe.mcp, (mcpName) =>
    lookUpRecipeReference(recipeName, 'mcp', config.mcpServers, mcpName).pipe(
      Effect.map((mcpServer) => [mcpName, claudeMcpServerOf(mcpServer)] as const),
    ),
  )
  const agentFiles = yield* Effect.forEach(recipe.agents, (agentName) =>
    readRepositoryFile(configDirectory, configFilePathOf.agent(agentName)),
  )
  const skillFiles = yield* Effect.forEach(recipe.skills, (skillName) =>
    readSkillFiles(configDirectory, skillName),
  )
  const tasks = yield* Effect.forEach(environment.tasks, (taskName) =>
    readPodFile(configDirectory, configFilePathOf.task(taskName), taskName),
  )

  return {
    commit,
    miseConfig: miseConfigOf(environment),
    tasks,
    repositories: recipe.repositories,
    claudeFiles: [...agentFiles, ...Arr.flatten(skillFiles)],
    mcpServers: Record.fromEntries(mcpServerEntries),
  }
})

const entryOf = (claudeFilePath: string) =>
  Arr.take(claudeFilePath.split('/'), CLAUDE_ENTRY_SEGMENT_COUNT).join('/')

const failOnForeignClaudeEntries = Effect.fn('failOnForeignClaudeEntries')(function* (
  paths: PodPaths,
  claudeFilePaths: readonly string[],
  previousManifest: Manifest,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const ownedEntries = Arr.map(previousManifest.claudeFiles, entryOf)
  const newEntries = Arr.difference(Arr.dedupe(Arr.map(claudeFilePaths, entryOf)), ownedEntries)

  yield* Effect.forEach(
    newEntries,
    (entry) => {
      const entryPath = path.join(paths.claudeDirectory, entry)

      return fileSystem.exists(entryPath).pipe(
        Effect.filterOrFail(
          (entryExists) => !entryExists,
          () => new ClaudeEntryNotPies({ entryPath }),
        ),
      )
    },
    { discard: true },
  )
})

const failOnForeignMcpServers = (
  mcpServers: PodConfig['mcpServers'],
  claudeMcpNames: readonly string[],
  previousManifest: Manifest,
) =>
  Arr.findFirst(
    Record.keys(mcpServers),
    (mcpName) =>
      Arr.contains(claudeMcpNames, mcpName) && !Record.has(previousManifest.mcpServers, mcpName),
  ).pipe(
    Option.match({
      onNone: () => Effect.void,
      onSome: (mcpName) => Effect.fail(new McpServerNotPies({ mcpName })),
    }),
  )

const writeFileIfChanged = Effect.fn('writeFileIfChanged')(function* (
  filePath: string,
  content: Uint8Array,
  fileMode: number,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const unchanged =
    (yield* fileSystem.exists(filePath)) &&
    Buffer.compare(yield* fileSystem.readFile(filePath), content) === 0

  if (!unchanged) {
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true })
    yield* fileSystem.writeFile(filePath, content, { mode: fileMode })
  }

  const currentMode = (yield* fileSystem.stat(filePath)).mode & PERMISSION_BITS

  if (currentMode !== fileMode) {
    yield* fileSystem.chmod(filePath, fileMode)
  }
})

const removeEmptyDirectory = Effect.fn('removeEmptyDirectory')(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem

  if (!(yield* fileSystem.exists(directory))) {
    return
  }

  if (Arr.isReadonlyArrayEmpty(yield* fileSystem.readDirectory(directory))) {
    yield* fileSystem.remove(directory, { recursive: true })
  }
})

const removeStaleClaudeFile = Effect.fn('removeStaleClaudeFile')(function* (
  claudeDirectory: string,
  claudeFilePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const segments = claudeFilePath.split('/')
  const directoriesInsideEntry = Arr.map(
    Arr.filter(
      Arr.scan(segments, Arr.empty<string>(), (prefix, segment) => [...prefix, segment]),
      (prefix) => prefix.length >= CLAUDE_ENTRY_SEGMENT_COUNT && prefix.length < segments.length,
    ),
    (prefix) => path.join(claudeDirectory, ...prefix),
  )

  yield* fileSystem.remove(path.join(claudeDirectory, claudeFilePath), { force: true })
  yield* Effect.forEach(Arr.reverse(directoriesInsideEntry), removeEmptyDirectory, {
    discard: true,
  })
})

const syncMcpServers = Effect.fn('syncMcpServers')(function* (
  paths: PodPaths,
  mcpServers: PodConfig['mcpServers'],
  claudeMcpNames: readonly string[],
  previousManifest: Manifest,
) {
  const runClaudeMcp = (claudeMcpArguments: readonly string[]) =>
    runMise(paths, ['exec', '--', 'claude', 'mcp', ...claudeMcpArguments])
  const removeMcpServer = (mcpName: string) =>
    runClaudeMcp(['remove', '--scope', 'user', mcpName]).pipe(
      Effect.when(Effect.succeed(Arr.contains(claudeMcpNames, mcpName))),
    )
  const addMcpServer = (mcpName: string, mcpServer: ClaudeMcpServer) =>
    runClaudeMcp(['add-json', '--scope', 'user', mcpName, JSON.stringify(mcpServer)])
  const staleMcpNames = Arr.difference(
    Record.keys(previousManifest.mcpServers),
    Record.keys(mcpServers),
  )

  yield* Effect.forEach(
    Record.toEntries(mcpServers),
    ([mcpName, mcpServer]) => {
      const alreadyAdded =
        Arr.contains(claudeMcpNames, mcpName) &&
        Option.exists(Record.get(previousManifest.mcpServers, mcpName), (previousMcpServer) =>
          isSameMcpServer(previousMcpServer, mcpServer),
        )

      return alreadyAdded
        ? Effect.void
        : removeMcpServer(mcpName).pipe(Effect.andThen(addMcpServer(mcpName, mcpServer)))
    },
    { discard: true },
  )
  yield* Effect.forEach(staleMcpNames, removeMcpServer, { discard: true })
})

const applyClaudeConfig = Effect.fn('applyClaudeConfig')(function* (
  paths: PodPaths,
  podConfig: PodConfig,
  previousManifest: Manifest,
  claudeMcpNames: readonly string[],
) {
  const path = yield* Path.Path
  const claudeFilePaths = claudeFilePathsOf(podConfig)

  yield* writeManifest(paths.manifestPath, {
    claudeFiles: Arr.union(previousManifest.claudeFiles, claudeFilePaths),
    mcpServers: { ...previousManifest.mcpServers, ...podConfig.mcpServers },
  })
  yield* Effect.forEach(
    podConfig.claudeFiles,
    (claudeFile) =>
      writeFileIfChanged(
        path.join(paths.claudeDirectory, claudeFile.path),
        claudeFile.content,
        claudeFile.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE,
      ),
    { discard: true },
  )
  yield* Effect.forEach(
    Arr.difference(previousManifest.claudeFiles, claudeFilePaths),
    (claudeFilePath) => removeStaleClaudeFile(paths.claudeDirectory, claudeFilePath),
    { discard: true },
  )
  yield* syncMcpServers(paths, podConfig.mcpServers, claudeMcpNames, previousManifest)
  yield* writeManifest(paths.manifestPath, {
    claudeFiles: claudeFilePaths,
    mcpServers: podConfig.mcpServers,
  })
})

const claudeFilePathsOf = (podConfig: PodConfig) =>
  Arr.map(podConfig.claudeFiles, (claudeFile) => claudeFile.path)

const runMise = (paths: PodPaths, miseArguments: readonly string[]) =>
  runCommand([paths.misePath, ...miseArguments], paths.home)

const installMiseWhenMissing = Effect.fn('installMiseWhenMissing')(function* (paths: PodPaths) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  if (yield* fileSystem.exists(paths.misePath)) {
    return
  }

  const installerPath = path.join(yield* fileSystem.makeTempDirectoryScoped(), 'install-mise.sh')

  yield* runCommand(['curl', '-fsSL', MISE_INSTALLER_URL, '-o', installerPath], paths.home)
  yield* runCommand(['sh', installerPath], paths.home)
}, Effect.scoped)

const addLineToShellStartupFile = Effect.fn('addLineToShellStartupFile')(function* (
  startupFilePath: string,
  startupLine: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const startupFile = (yield* fileSystem.exists(startupFilePath))
    ? yield* fileSystem.readFileString(startupFilePath)
    : ''

  if (!Arr.contains(startupFile.split('\n'), startupLine)) {
    yield* fileSystem.writeFileString(startupFilePath, `\n${startupLine}\n`, { flag: 'a' })
  }
})

const installTools = Effect.fn('installTools')(function* (paths: PodPaths, podConfig: PodConfig) {
  yield* installMiseWhenMissing(paths)
  yield* writeFileIfChanged(
    paths.miseConfigPath,
    new TextEncoder().encode(podConfig.miseConfig),
    REGULAR_FILE_MODE,
  )
  yield* runMise(paths, ['install'])
  yield* Effect.forEach(paths.shellStartupPaths, (startupFilePath) =>
    addLineToShellStartupFile(startupFilePath, MISE_SHIMS_PATH_LINE),
  )
})

const runTasks = Effect.fn('runTasks')(function* (paths: PodPaths, podConfig: PodConfig) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const taskDirectory = yield* fileSystem.makeTempDirectoryScoped()

  yield* Effect.forEach(
    podConfig.tasks,
    (task) => {
      const taskPath = path.join(taskDirectory, task.path)

      return writeFileIfChanged(taskPath, task.content, EXECUTABLE_FILE_MODE).pipe(
        Effect.andThen(runMise(paths, ['exec', '--', taskPath])),
      )
    },
    { discard: true },
  )
}, Effect.scoped)

const cloneMissingRepositories = Effect.fn('cloneMissingRepositories')(function* (
  paths: PodPaths,
  podConfig: PodConfig,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* Effect.forEach(
    podConfig.repositories,
    (repository) => {
      const checkoutPath = path.join(paths.workspaceDirectory, repository.dir)

      return runCommand(
        ['git', 'clone', `${paths.githubUrl}/${repository.repo}.git`, checkoutPath],
        paths.home,
      ).pipe(Effect.when(Effect.map(fileSystem.exists(checkoutPath), (cloned) => !cloned)))
    },
    { discard: true },
  )
})

const applyPodConfig = Effect.fn('applyPodConfig')(function* (
  paths: PodPaths,
  podConfig: PodConfig,
) {
  const previousManifest = yield* readManifest(paths.manifestPath, EMPTY_MANIFEST)
  const claudeMcpNames = yield* readClaudeMcpNames(paths.claudeStatePath)

  yield* failOnForeignClaudeEntries(paths, claudeFilePathsOf(podConfig), previousManifest)
  yield* failOnForeignMcpServers(podConfig.mcpServers, claudeMcpNames, previousManifest)
  yield* installTools(paths, podConfig)
  yield* runTasks(paths, podConfig)
  yield* cloneMissingRepositories(paths, podConfig)
  yield* applyClaudeConfig(paths, podConfig, previousManifest, claudeMcpNames)
})

export const upPod = Effect.fn('upPod')(function* (
  configRepositoryArgument: Option.Option<string>,
) {
  const paths = yield* podPaths
  const repositoryName = yield* configRepositoryOf(paths, configRepositoryArgument)
  const recipeName = yield* recipeNameOfThisVm
  const { checkoutDirectory, commit } = yield* syncConfigCheckout(paths, repositoryName)

  yield* rememberConfigRepository(paths, repositoryName)

  const podConfig = yield* podConfigOf(checkoutDirectory, recipeName, commit)

  yield* applyPodConfig(paths, podConfig)

  return { recipeName, commit }
})
