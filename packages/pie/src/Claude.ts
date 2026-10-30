import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import {
  ClaudeSettings,
  McpServer,
  type RepositoryName,
  type ResolvedRecipe,
} from './ConfigRepo.ts'
import type { RecipeName } from './ExeDev.ts'
import { Mise } from './Mise.ts'
import {
  BOX_LAYOUT,
  Box,
  EXECUTABLE_FILE_MODE,
  homePathOf,
  MARKDOWN_BLOCK_MARKERS,
  REGULAR_FILE_MODE,
  withBlock,
} from './Pod.ts'

interface ClaudeState {
  readonly previousManifest: Manifest
  readonly claudeMcpNames: readonly string[]
}

const CLAUDE_ENTRY_SEGMENT_COUNT = 2
const MANIFEST_FILE_NAME = 'manifest.json'
const SETTINGS_FILE_NAME = 'settings.json'
const INSTRUCTIONS_FILE_NAME = 'CLAUDE.md'

const Manifest = Schema.Struct({
  claudeFiles: Schema.Array(Schema.String),
  claudeSettingsKeys: Schema.Array(Schema.String),
  mcpServers: Schema.Record(Schema.String, McpServer),
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

const isSameMcpServer = Schema.toEquivalence(McpServer)

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

export const claudeConfigOf = (recipe: ResolvedRecipe) => ({
  files: recipe.claude.files,
  settings: recipe.claude.settings,
  mcpServers: recipe.mcp,
})

type ClaudeConfig = ReturnType<typeof claudeConfigOf>

const claudeFilePathsOf = (claudeConfig: ClaudeConfig) =>
  Arr.map(claudeConfig.files, (claudeFile) => claudeFile.claudePath)

const entryOf = (claudeFilePath: string) =>
  Arr.take(claudeFilePath.split('/'), CLAUDE_ENTRY_SEGMENT_COUNT).join('/')

export const claudeInstructionsOf = (recipeName: string, configRepository: string) =>
  `## pie

This VM is a pie pod: recipe \`${recipeName}\` from \`${configRepository}\`.

- The config repo is the source of truth. pie owns the tools, the home set files and \`~/.claude\`'s agents, settings, skills and MCPs. \`pie pod up\` overwrites local edits to them, so change the config repo instead. \`~/${homePathOf(BOX_LAYOUT.pieConfigDirectory)}/*manifest.json\` lists what pie owns.
- Tools are pinned by mise. To add one, add it to the recipe's environment rather than installing it globally.
- Repos live in \`~/${homePathOf(BOX_LAYOUT.workspace)}\`.
- There are no secrets on this box. exe.dev integrations add auth at the network edge. If a request is denied, an integration is probably missing. Tell the user which one; don't ask for a token.
- \`pie pod up\` re-applies the recipe.
`

export class Claude extends Context.Service<Claude>()('pie/Claude', {
  make: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const box = yield* Box
    const mise = yield* Mise
    const claudeDirectory = box.paths.claudeDirectory
    const settingsPath = path.join(claudeDirectory, SETTINGS_FILE_NAME)
    const manifestPath = path.join(box.paths.pieConfigDirectory, MANIFEST_FILE_NAME)

    const readState = Effect.fn('Claude.readState')(function* () {
      const previousManifest = yield* box.readJsonFile(ManifestJson, manifestPath, EMPTY_MANIFEST)
      const claudeState = yield* box.readJsonFile(ClaudeStateJson, box.paths.claudeState, {})
      const state: ClaudeState = {
        previousManifest,
        claudeMcpNames: Record.keys(claudeState.mcpServers ?? {}),
      }

      return state
    })

    const failOnForeign = Effect.fn('Claude.failOnForeign')(function* (
      claudeConfig: ClaudeConfig,
      { previousManifest, claudeMcpNames }: ClaudeState,
    ) {
      const ownedEntries = Arr.map(previousManifest.claudeFiles, entryOf)
      const newEntries = pipe(
        claudeFilePathsOf(claudeConfig),
        Arr.map(entryOf),
        Arr.dedupe,
        Arr.difference(ownedEntries),
      )

      yield* Effect.forEach(
        newEntries,
        (entry) => {
          const entryPath = path.join(claudeDirectory, entry)

          return box.failIfPresent(entryPath, () => new ClaudeEntryNotPies({ entryPath }))
        },
        { discard: true },
      )
      yield* Arr.findFirst(
        Record.keys(claudeConfig.mcpServers),
        (mcpName) =>
          Arr.contains(claudeMcpNames, mcpName) &&
          !Record.has(previousManifest.mcpServers, mcpName),
      ).pipe(
        Option.match({
          onNone: () => Effect.void,
          onSome: (mcpName) => Effect.fail(new McpServerNotPies({ mcpName })),
        }),
      )
    })

    const removeEmptyDirectory = Effect.fn('Claude.removeEmptyDirectory')(function* (
      directory: string,
    ) {
      if (!(yield* fileSystem.exists(directory))) {
        return
      }

      if (Arr.isReadonlyArrayEmpty(yield* fileSystem.readDirectory(directory))) {
        yield* fileSystem.remove(directory, { recursive: true })
      }
    })

    const removeStaleFile = Effect.fn('Claude.removeStaleFile')(function* (claudeFilePath: string) {
      const segments = claudeFilePath.split('/')
      const directoriesInsideEntry = pipe(
        segments,
        Arr.scan(Arr.empty<string>(), (prefix, segment) => [...prefix, segment]),
        Arr.filter(
          (prefix) =>
            prefix.length >= CLAUDE_ENTRY_SEGMENT_COUNT && prefix.length < segments.length,
        ),
        Arr.map((prefix) => path.join(claudeDirectory, ...prefix)),
      )

      yield* fileSystem.remove(path.join(claudeDirectory, claudeFilePath), { force: true })
      yield* Effect.forEach(Arr.reverse(directoriesInsideEntry), removeEmptyDirectory, {
        discard: true,
      })
    })

    const runClaudeMcp = (claudeMcpArguments: readonly string[]) =>
      mise.exec(['claude', 'mcp', ...claudeMcpArguments])

    const syncMcpServers = Effect.fn('Claude.syncMcpServers')(function* (
      mcpServers: ClaudeConfig['mcpServers'],
      { previousManifest, claudeMcpNames }: ClaudeState,
    ) {
      const removeMcpServer = Effect.fn('Claude.removeMcpServer')(function* (mcpName: string) {
        if (Arr.contains(claudeMcpNames, mcpName)) {
          yield* runClaudeMcp(['remove', '--scope', 'user', mcpName])
        }
      })
      const addMcpServer = (mcpName: string, mcpServer: McpServer) =>
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

    const mergeSettings = Effect.fn('Claude.mergeSettings')(function* (
      claudeSettings: ClaudeSettings,
      previousManifest: Manifest,
    ) {
      const staleKeys = Arr.difference(
        previousManifest.claudeSettingsKeys,
        Record.keys(claudeSettings),
      )

      if (Record.isEmptyRecord(claudeSettings) && Arr.isReadonlyArrayEmpty(staleKeys)) {
        return
      }

      const currentSettings = yield* box.readJsonFile(ClaudeSettingsJson, settingsPath, {})
      const mergedSettings = {
        ...Record.filter(currentSettings, (_value, key) => !Arr.contains(staleKeys, key)),
        ...claudeSettings,
      }
      const settingsText = yield* Schema.encodeEffect(ClaudeSettingsJson)(mergedSettings)

      yield* box.writeFileIfChanged(settingsPath, `${settingsText}\n`, REGULAR_FILE_MODE)
    })

    const apply = Effect.fn('Claude.apply')(function* (
      claudeConfig: ClaudeConfig,
      claudeState: ClaudeState,
    ) {
      const { previousManifest } = claudeState
      const claudeFilePaths = claudeFilePathsOf(claudeConfig)

      yield* box.writeOwned(
        ManifestJson,
        manifestPath,
        {
          union: {
            claudeFiles: Arr.union(previousManifest.claudeFiles, claudeFilePaths),
            claudeSettingsKeys: Arr.union(
              previousManifest.claudeSettingsKeys,
              Record.keys(claudeConfig.settings),
            ),
            mcpServers: { ...previousManifest.mcpServers, ...claudeConfig.mcpServers },
          },
          final: {
            claudeFiles: claudeFilePaths,
            claudeSettingsKeys: Record.keys(claudeConfig.settings),
            mcpServers: claudeConfig.mcpServers,
          },
        },
        Effect.gen(function* () {
          yield* Effect.forEach(
            claudeConfig.files,
            (claudeFile) =>
              box.writeFileIfChanged(
                path.join(claudeDirectory, claudeFile.claudePath),
                claudeFile.content,
                claudeFile.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE,
              ),
            { discard: true },
          )
          yield* Effect.forEach(
            Arr.difference(previousManifest.claudeFiles, claudeFilePaths),
            removeStaleFile,
            { discard: true },
          )
          yield* mergeSettings(claudeConfig.settings, previousManifest)
          yield* syncMcpServers(claudeConfig.mcpServers, claudeState)
        }),
      )
    })

    const writeInstructions = Effect.fn('Claude.writeInstructions')(function* (
      recipeName: RecipeName,
      configRepository: RepositoryName,
      claudeMdTexts: readonly string[],
    ) {
      const blockContent = pipe(
        [claudeInstructionsOf(recipeName, configRepository), ...claudeMdTexts],
        Arr.map(Str.trim),
        Arr.filter(Str.isNonEmpty),
        Arr.join('\n\n'),
      )

      yield* box.updateTextFile(path.join(claudeDirectory, INSTRUCTIONS_FILE_NAME), (text) =>
        withBlock(text, MARKDOWN_BLOCK_MARKERS, blockContent),
      )
    })

    return { readState, failOnForeign, apply, writeInstructions }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(Layer.mergeAll(Box.layer, Mise.layer)),
  )
}
