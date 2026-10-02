import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import {
  ClaudeSettings,
  configFilePathOf,
  HttpMcpServer,
  listDirectory,
  type McpServer,
  type ResolvedRecipe,
} from './ConfigRepo.ts'
import { runMise } from './Mise.ts'
import {
  configHome,
  decodeJsonFile,
  EXECUTABLE_FILE_MODE,
  homeDirectory,
  readPodFile,
  REGULAR_FILE_MODE,
  writeFileIfChanged,
  writeManifest,
} from './Pod.ts'

const CLAUDE_ENTRY_SEGMENT_COUNT = 2

const ClaudeMcpServer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('http'), url: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('stdio'),
    command: Schema.String,
    args: Schema.Array(Schema.String),
  }),
])

type ClaudeMcpServer = typeof ClaudeMcpServer.Type

const Manifest = Schema.Struct({
  claudeFiles: Schema.Array(Schema.String),
  claudeSettingsKeys: Schema.Array(Schema.String),
  mcpServers: Schema.Record(Schema.String, ClaudeMcpServer),
})

type Manifest = typeof Manifest.Type

const ManifestJson = Schema.fromJsonString(Manifest)

const EMPTY_MANIFEST: Manifest = { claudeFiles: [], claudeSettingsKeys: [], mcpServers: {} }

const ClaudeSettingsJson = Schema.fromJsonString(ClaudeSettings, { space: 2 })

const ClaudeStateJson = Schema.fromJsonString(
  Schema.Struct({
    mcpServers: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  }),
)

const writeClaudeManifest = writeManifest(ManifestJson)

const isSameMcpServer = Schema.toEquivalence(ClaudeMcpServer)

const isHttpMcpServer = Schema.is(HttpMcpServer)

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

const claudePaths = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* homeDirectory

  return {
    claudeDirectory: path.join(home, '.claude'),
    settingsPath: path.join(home, '.claude', 'settings.json'),
    statePath: path.join(home, '.claude.json'),
    manifestPath: path.join(yield* configHome, 'pie', 'manifest.json'),
  }
})

const claudeMcpServerOf = (mcpServer: McpServer): ClaudeMcpServer =>
  isHttpMcpServer(mcpServer)
    ? { type: 'http', url: mcpServer.url }
    : { type: 'stdio', command: mcpServer.command, args: mcpServer.args }

const readSkillFiles = Effect.fn('readSkillFiles')(function* (
  configDirectory: string,
  skillName: string,
) {
  const path = yield* Path.Path
  const skillDirectory = path.dirname(configFilePathOf.skill(skillName))
  const skillFilePaths = yield* listDirectory(configDirectory, skillDirectory, 'File', {
    recursive: true,
  })

  return yield* Effect.forEach(skillFilePaths, (skillFilePath) => {
    const filePath = path.join(skillDirectory, skillFilePath)

    return readPodFile(configDirectory, filePath, filePath)
  })
})

export const claudeConfigOf = Effect.fn('claudeConfigOf')(function* (
  configDirectory: string,
  recipe: ResolvedRecipe,
) {
  const agentFiles = yield* Effect.forEach(recipe.claude.agents, (agentName) =>
    readPodFile(configDirectory, configFilePathOf.agent(agentName), `agents/${agentName}.md`),
  )
  const skillFiles = yield* Effect.forEach(recipe.skills, (skillName) =>
    readSkillFiles(configDirectory, skillName),
  )

  return {
    files: [...agentFiles, ...Arr.flatten(skillFiles)],
    settings: recipe.claude.settings,
    mcpServers: Record.map(recipe.mcp, claudeMcpServerOf),
  }
})

type ClaudeConfig = Effect.Success<ReturnType<typeof claudeConfigOf>>

export const readClaudeState = Effect.fn('readClaudeState')(function* () {
  const paths = yield* claudePaths
  const previousManifest = yield* decodeJsonFile(ManifestJson)(paths.manifestPath, EMPTY_MANIFEST)
  const claudeState = yield* decodeJsonFile(ClaudeStateJson)(paths.statePath, {})

  return { previousManifest, claudeMcpNames: Record.keys(claudeState.mcpServers ?? {}) }
})

type ClaudeState = Effect.Success<ReturnType<typeof readClaudeState>>

const claudeFilePathsOf = (claudeConfig: ClaudeConfig) =>
  Arr.map(claudeConfig.files, (claudeFile) => claudeFile.path)

const entryOf = (claudeFilePath: string) =>
  Arr.take(claudeFilePath.split('/'), CLAUDE_ENTRY_SEGMENT_COUNT).join('/')

export const failOnForeignClaudeConfig = Effect.fn('failOnForeignClaudeConfig')(function* (
  claudeConfig: ClaudeConfig,
  { previousManifest, claudeMcpNames }: ClaudeState,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { claudeDirectory } = yield* claudePaths
  const ownedEntries = Arr.map(previousManifest.claudeFiles, entryOf)
  const newEntries = Arr.difference(
    Arr.dedupe(Arr.map(claudeFilePathsOf(claudeConfig), entryOf)),
    ownedEntries,
  )

  yield* Effect.forEach(
    newEntries,
    (entry) => {
      const entryPath = path.join(claudeDirectory, entry)

      return fileSystem.exists(entryPath).pipe(
        Effect.filterOrFail(
          (entryExists) => !entryExists,
          () => new ClaudeEntryNotPies({ entryPath }),
        ),
      )
    },
    { discard: true },
  )
  yield* Arr.findFirst(
    Record.keys(claudeConfig.mcpServers),
    (mcpName) =>
      Arr.contains(claudeMcpNames, mcpName) && !Record.has(previousManifest.mcpServers, mcpName),
  ).pipe(
    Option.match({
      onNone: () => Effect.void,
      onSome: (mcpName) => Effect.fail(new McpServerNotPies({ mcpName })),
    }),
  )
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
  mcpServers: ClaudeConfig['mcpServers'],
  { previousManifest, claudeMcpNames }: ClaudeState,
) {
  const runClaudeMcp = (claudeMcpArguments: readonly string[]) =>
    runMise(['exec', '--', 'claude', 'mcp', ...claudeMcpArguments])
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

const mergeClaudeSettings = Effect.fn('mergeClaudeSettings')(function* (
  settingsPath: string,
  claudeSettings: ClaudeSettings,
  previousManifest: Manifest,
) {
  const staleKeys = Arr.difference(previousManifest.claudeSettingsKeys, Record.keys(claudeSettings))

  if (Record.isEmptyRecord(claudeSettings) && Arr.isReadonlyArrayEmpty(staleKeys)) {
    return
  }

  const currentSettings = yield* decodeJsonFile(ClaudeSettingsJson)(settingsPath, {})
  const mergedSettings = {
    ...Record.filter(currentSettings, (_value, key) => !Arr.contains(staleKeys, key)),
    ...claudeSettings,
  }

  const settingsText = yield* Schema.encodeEffect(ClaudeSettingsJson)(mergedSettings)

  yield* writeFileIfChanged(
    settingsPath,
    new TextEncoder().encode(`${settingsText}\n`),
    REGULAR_FILE_MODE,
  )
})

export const applyClaudeConfig = Effect.fn('applyClaudeConfig')(function* (
  claudeConfig: ClaudeConfig,
  claudeState: ClaudeState,
) {
  const path = yield* Path.Path
  const paths = yield* claudePaths
  const { previousManifest } = claudeState
  const claudeFilePaths = claudeFilePathsOf(claudeConfig)

  yield* writeClaudeManifest(paths.manifestPath, {
    claudeFiles: Arr.union(previousManifest.claudeFiles, claudeFilePaths),
    claudeSettingsKeys: Arr.union(
      previousManifest.claudeSettingsKeys,
      Record.keys(claudeConfig.settings),
    ),
    mcpServers: { ...previousManifest.mcpServers, ...claudeConfig.mcpServers },
  })
  yield* Effect.forEach(
    claudeConfig.files,
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
  yield* mergeClaudeSettings(paths.settingsPath, claudeConfig.settings, previousManifest)
  yield* syncMcpServers(claudeConfig.mcpServers, claudeState)
  yield* writeClaudeManifest(paths.manifestPath, {
    claudeFiles: claudeFilePaths,
    claudeSettingsKeys: Record.keys(claudeConfig.settings),
    mcpServers: claudeConfig.mcpServers,
  })
})
