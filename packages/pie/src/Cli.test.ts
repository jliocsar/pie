import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import * as CliError from 'effect/unstable/cli/CliError'
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { pie } from './Cli.ts'
import { ConfigReferenceMissing } from './ConfigRepo.ts'
import { SchemaFileStale, SchemaLineMissing } from './EditorSchemas.ts'
import { ClaudeEntryNotPies, McpServerNotPies } from './Claude.ts'
import { RecipeTagMissing, RecipeTagsConflict, VmTagsMissing } from './ExeDev.ts'
import { RememberedConfigRepositoryInvalid, RepositoryUnreachable } from './Git.ts'
import { HomeFileNotPies } from './HomeSets.ts'
import {
  commitToConfigSource,
  CONFIG_REPOSITORY,
  EXECUTABLE_FILE_MODE,
  inFreshDirectory,
  makeConfigSource,
  runGit,
  SEED_CONFIG_FILES,
  writeFilesUnder,
} from './test/TestPie.ts'

interface RunOptions {
  readonly failingRun?: string
  readonly environment?: Record.ReadonlyRecord<string, string>
}

interface SpawnedCommand {
  readonly programName: string
  readonly stdin: unknown
}

interface RecordedRun {
  readonly machineName: string
  readonly commandLine: string
  readonly workingDirectory: string | undefined
}

const PERMISSION_BITS = 0o777
const PERSONAL_POD_TAGS = ['pie', 'pie-recipe-personal']
const CHECKED_OUT_REPOSITORY_DIRECTORIES = ['jliocsar/pie', 'nidus']
const TEMPORARY_FILE_RUN_PATTERN = /^(?<runner>exec --|sh|curl .*) \/\S*\/(?<fileName>[^/\s]+)$/u
const INTEGRATIONS_WITH_LOCAL_REPOSITORIES = ['github', 'hapana-gh-git']
const TOOL_AND_TASK_CALLS = ['install', 'exec -- <temporary>/workspace']

const MCP_ADD_CALLS = [
  'exec -- claude mcp add-json --scope user fff {"type":"stdio","command":"fff-mcp","args":[]}',
  'exec -- claude mcp add-json --scope user docs {"type":"http","url":"https://docs.example/mcp"}',
]

const MISE_PROFILE_BLOCK =
  '# >>> pie: mise >>>\nexport PATH="$HOME/.local/share/mise/shims:$PATH"\n# <<< pie: mise <<<\n'

const MISE_ZSHRC_BLOCK =
  '# >>> pie: mise >>>\neval "$($HOME/.local/bin/mise activate zsh)"\n# <<< pie: mise <<<\n'

const INSTRUCTION_BULLETS_PATTERN = /(?:^- .*\n)+/mu
const CLAUDE_INSTRUCTIONS = `## pie\n\nThis VM is a pie pod: recipe \`personal\` from \`${CONFIG_REPOSITORY}\`.\n\n<bullets>\n`
const CLAUDE_INSTRUCTIONS_BLOCK = `<!-- >>> pie >>> -->\n${CLAUDE_INSTRUCTIONS}<!-- <<< pie <<< -->\n`
const CLAUDE_MD_BLOCK = `<!-- >>> pie >>> -->\n${CLAUDE_INSTRUCTIONS}\n${SEED_CONFIG_FILES['claude/claude_md/work.md']}\n${SEED_CONFIG_FILES['claude/claude_md/gcp.md']}\n<!-- <<< pie <<< -->\n`
const HOME_FILE_PATHS = ['.profile', '.zshrc', '.config/starship.toml']

const WORK_RECIPE_TOML = SEED_CONFIG_FILES['recipes/personal.toml'].replace(
  'label = "Personal"\n',
  'label = "Personal"\ntags = ["work-gh", "work-gcp"]\n',
)

const bunServicesRuntime = ManagedRuntime.make(BunServices.layer)

const capturingConsole = () => {
  const stdout: string[] = []
  const console: Console.Console = {
    ...globalThis.console,
    log: (...parts: readonly string[]) => {
      stdout.push(parts.join(' '))
    },
  }

  return { stdout, console }
}

const withInstructionBulletsMasked = (text: string) =>
  text.replace(INSTRUCTION_BULLETS_PATTERN, '<bullets>\n')

const reflectionAnswering = (vmName: string, vmTags: readonly string[]) => {
  const reflection: Record.ReadonlyRecord<string, unknown> = {
    'https://reflection.int.exe.xyz/': { name: vmName },
    'https://reflection.int.exe.xyz/tags': { tags: vmTags },
  }

  return Object.assign(
    (input: string | URL | Request) =>
      Promise.resolve(
        Option.match(Record.get(reflection, String(input instanceof Request ? input.url : input)), {
          onNone: () => new Response(null, { status: 404 }),
          onSome: (body) => Response.json(body),
        }),
      ),
    { preconnect: globalThis.fetch.preconnect },
  )
}

const startPods = Effect.fn('startPods')(function* (temporaryDirectory: string) {
  const path = yield* Path.Path
  const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const { sourceDirectory } = yield* makeConfigSource(temporaryDirectory)
  const output = capturingConsole()
  const recordedRuns: RecordedRun[] = []
  const spawnedCommands: SpawnedCommand[] = []
  const homeOf = (machineName: string) => path.join(temporaryDirectory, machineName)
  const gitConfigArguments = Arr.flatMap(
    INTEGRATIONS_WITH_LOCAL_REPOSITORIES,
    (integrationName) => [
      '-c',
      `url.${path.join(temporaryDirectory, integrationName)}/.insteadOf=https://${integrationName}.int.exe.xyz/`,
    ],
  )
  const spawnerOn = (machineName: string, { failingRun }: RunOptions) =>
    ChildProcessSpawner.make((command) => {
      if (!ChildProcess.isStandardCommand(command)) {
        return realSpawner.spawn(command)
      }

      spawnedCommands.push({
        programName: path.basename(command.command),
        stdin: command.options.stdin,
      })

      if (command.command === 'git') {
        return realSpawner.spawn(
          ChildProcess.make('git', [...gitConfigArguments, ...command.args], command.options),
        )
      }

      const miseBinary = path.join(homeOf(machineName), '.local', 'bin', 'mise')
      const commandLine = (
        command.command === miseBinary ? command.args : [command.command, ...command.args]
      ).join(' ')
      const runFails = failingRun !== undefined && commandLine.includes(failingRun)

      recordedRuns.push({ machineName, commandLine, workingDirectory: command.options.cwd })

      return realSpawner.spawn(ChildProcess.make(runFails ? 'false' : 'true', [], command.options))
    })
  const recordedRunsOn = (machineName: string) =>
    Arr.filter(recordedRuns, (recordedRun) => recordedRun.machineName === machineName)
  const miseCallsOn = (machineName: string) =>
    Arr.map(recordedRunsOn(machineName), ({ commandLine }) =>
      commandLine.replace(TEMPORARY_FILE_RUN_PATTERN, '$<runner> <temporary>/$<fileName>'),
    )
  const runPieOn = (
    machineName: string,
    commandLine: readonly string[],
    vmTags: readonly string[] = PERSONAL_POD_TAGS,
    runOptions: RunOptions = {},
  ) =>
    Command.runWith(pie, { version: '0.0.0-test' })(commandLine).pipe(
      Effect.provideService(FetchHttpClient.Fetch, reflectionAnswering(machineName, vmTags)),
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        spawnerOn(machineName, runOptions),
      ),
      Effect.provideService(Console.Console, output.console),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { ...runOptions.environment, HOME: homeOf(machineName) } }),
      ),
    )

  return { sourceDirectory, output, homeOf, runPieOn, recordedRunsOn, miseCallsOn, spawnedCommands }
})

const prepareBox = Effect.fn('prepareBox')(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const misePath = path.join(home, '.local', 'bin', 'mise')

  yield* fileSystem.makeDirectory(path.dirname(misePath), { recursive: true })
  yield* fileSystem.writeFileString(misePath, '')
  yield* Effect.forEach(
    CHECKED_OUT_REPOSITORY_DIRECTORIES,
    (repositoryDirectory) =>
      fileSystem.makeDirectory(path.join(home, 'workspace', repositoryDirectory), {
        recursive: true,
      }),
    { discard: true },
  )
})

const snapshotFiles = Effect.fn('snapshotFiles')(function* (
  directory: string,
  filePaths: readonly string[],
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* Effect.forEach(filePaths, (filePath) =>
    Effect.all({
      text: fileSystem.readFileString(path.join(directory, filePath)),
      fileInfo: fileSystem.stat(path.join(directory, filePath)),
    }).pipe(
      Effect.map(
        ({ text, fileInfo }) =>
          [
            filePath,
            {
              text,
              mode: fileInfo.mode & PERMISSION_BITS,
              modifiedAt: Option.getOrNull(fileInfo.mtime),
            },
          ] as const,
      ),
    ),
  )

  return Record.fromEntries(files)
})

const snapshotDirectory = Effect.fn('snapshotDirectory')(function* (directory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entryPaths = yield* fileSystem.readDirectory(directory, { recursive: true })
  const filePaths = yield* Effect.filter(entryPaths, (entryPath) =>
    fileSystem
      .stat(path.join(directory, entryPath))
      .pipe(Effect.map((fileInfo) => fileInfo.type === 'File')),
  )

  return yield* snapshotFiles(directory, filePaths)
})

const snapshotHomeFiles = Effect.fn('snapshotHomeFiles')(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existingHomeFilePaths = yield* Effect.filter(HOME_FILE_PATHS, (homeFilePath) =>
    fileSystem.exists(path.join(home, homeFilePath)),
  )

  return yield* snapshotFiles(home, existingHomeFilePaths)
})

const writeClaudeState = Effect.fn('writeClaudeState')(function* (
  home: string,
  mcpNames: readonly string[],
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const claudeState = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
    numStartups: 1,
    mcpServers: Record.fromEntries(Arr.map(mcpNames, (mcpName) => [mcpName, {}] as const)),
  })

  yield* fileSystem.writeFileString(path.join(home, '.claude.json'), claudeState)
})

const writeOwnClaudeSettings = Effect.fn('writeOwnClaudeSettings')(function* (
  home: string,
  claudeSettings: Record.ReadonlyRecord<string, string>,
) {
  yield* writeFilesUnder(home, {
    '.claude/settings.json': yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
      claudeSettings,
    ),
  })
})

const readSchemaDefinitions = Effect.fn('readSchemaDefinitions')(function* (
  configDirectory: string,
  tomlKind: 'recipe' | 'environment' | 'mcp',
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const schemaText = yield* fileSystem.readFileString(
    path.join(configDirectory, '.pie', 'schema', `${tomlKind}.json`),
  )
  const { $defs } = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ $defs: Schema.Unknown })),
  )(schemaText)

  return $defs
})

afterAll(() => bunServicesRuntime.dispose())

describe('pie pod up', () => {
  test('installs the tools, runs the tasks, writes ~/.claude, adds MCPs through claude, and a rerun changes nothing', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { output, homeOf, miseCallsOn, recordedRunsOn, runPieOn, sourceDirectory } =
            yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const claudeDirectory = path.join(home, '.claude')
          const pieConfigDirectory = path.join(home, '.config', 'pie')
          const claudeStatePath = path.join(home, '.claude.json')
          const headCommit = yield* runGit(['-C', sourceDirectory, 'rev-parse', 'HEAD'])
          const abbreviatedCommit = headCommit.slice(0, 7)

          yield* prepareBox(home)
          yield* fileSystem.writeFileString(path.join(home, '.zshrc'), '# stock\n', {
            mode: 0o644,
          })
          yield* writeOwnClaudeSettings(home, { theme: 'dark', model: 'sonnet' })
          yield* fileSystem.writeFileString(path.join(claudeDirectory, 'CLAUDE.md'), '# stock\n', {
            mode: 0o644,
          })
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* writeClaudeState(home, ['fff', 'docs'])

          const firstMiseCalls = miseCallsOn('pod')
          const firstSnapshot = yield* snapshotDirectory(claudeDirectory)
          const firstHomeSnapshot = yield* snapshotHomeFiles(home)
          const firstPieConfigSnapshot = yield* snapshotDirectory(pieConfigDirectory)
          const firstClaudeState = yield* fileSystem.readFileString(claudeStatePath)

          yield* runPieOn('pod', ['pod', 'up'])

          const secondMiseCalls = miseCallsOn('pod')
          const secondSnapshot = yield* snapshotDirectory(claudeDirectory)
          const secondHomeSnapshot = yield* snapshotHomeFiles(home)
          const secondPieConfigSnapshot = yield* snapshotDirectory(pieConfigDirectory)
          const secondClaudeState = yield* fileSystem.readFileString(claudeStatePath)
          const miseConfig: unknown = Bun.TOML.parse(
            yield* fileSystem.readFileString(
              path.join(home, '.config', 'mise', 'conf.d', 'pie.toml'),
            ),
          )

          expect(firstMiseCalls).toEqual([...TOOL_AND_TASK_CALLS, ...MCP_ADD_CALLS])
          expect(
            pipe(
              recordedRunsOn('pod'),
              Arr.map((recordedRun) => recordedRun.workingDirectory),
              Arr.dedupe,
            ),
          ).toEqual([home])
          expect(
            Record.map(firstSnapshot, ({ text, mode }) => ({
              text: withInstructionBulletsMasked(text),
              mode,
            })),
          ).toEqual({
            'CLAUDE.md': { text: `# stock\n${CLAUDE_MD_BLOCK}`, mode: 0o644 },
            'agents/oracle.md': {
              text: SEED_CONFIG_FILES['claude/agents/oracle.md'],
              mode: 0o644,
            },
            'settings.json': {
              text: '{\n  "theme": "dark",\n  "model": "opus",\n  "includeCoAuthoredBy": false\n}\n',
              mode: 0o644,
            },
            'skills/handoff/SKILL.md': {
              text: SEED_CONFIG_FILES['skills/handoff/SKILL.md'],
              mode: 0o644,
            },
            'skills/handoff/scripts/greet': {
              text: SEED_CONFIG_FILES['skills/handoff/scripts/greet'],
              mode: EXECUTABLE_FILE_MODE,
            },
          })
          expect(secondMiseCalls).toEqual([...firstMiseCalls, ...TOOL_AND_TASK_CALLS])
          expect(miseConfig).toEqual({
            settings: { tool_update: { global_auto: true } },
            tools: {
              node: { version: '24.19.0' },
              'github:dmtrKovalenko/fff': {
                version: '0.10.6',
                matching: 'fff-mcp',
                bin: 'fff-mcp',
              },
            },
            env: { GH_HOST: 'github.int.exe.xyz' },
          })
          expect(firstSnapshot['CLAUDE.md']?.text).toContain(
            `\`${pieConfigDirectory}/*manifest.json\``,
          )
          expect(firstSnapshot['CLAUDE.md']?.text).toContain('`~/workspace`')
          expect(Record.map(firstHomeSnapshot, ({ text, mode }) => ({ text, mode }))).toEqual({
            '.profile': { text: MISE_PROFILE_BLOCK, mode: 0o644 },
            '.zshrc': {
              text: `# stock\n${MISE_ZSHRC_BLOCK}# >>> pie: home/zsh >>>\nalias ll='ls -l'\n# <<< pie: home/zsh <<<\n`,
              mode: 0o644,
            },
            '.config/starship.toml': {
              text: SEED_CONFIG_FILES['home/shell/.config/starship.toml'],
              mode: 0o644,
            },
          })
          expect(secondHomeSnapshot).toEqual(firstHomeSnapshot)
          expect(secondSnapshot).toEqual(firstSnapshot)
          expect(secondPieConfigSnapshot).toEqual(firstPieConfigSnapshot)
          expect(secondClaudeState).toBe(firstClaudeState)
          expect(output.stdout).toEqual(
            Arr.replicate(`Applied recipe personal at config commit ${abbreviatedCommit}.`, 2),
          )
        }),
      ),
    ))

  test("appends the recipe's claude_md files to pie's CLAUDE.md block in order, leaving the text around it alone", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const claudeMdPath = path.join(home, '.claude', 'CLAUDE.md')

          yield* prepareBox(home)
          yield* writeFilesUnder(home, {
            '.claude/CLAUDE.md':
              '# stock\n<!-- >>> pie >>> -->\nstale\n<!-- <<< pie <<< -->\n# mine\n',
          })
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])

          const claudeMd = yield* fileSystem.readFileString(claudeMdPath)

          expect(withInstructionBulletsMasked(claudeMd)).toBe(`# stock\n${CLAUDE_MD_BLOCK}# mine\n`)
        }),
      ),
    ))

  test("removes what a changed recipe dropped, and leaves what pie didn't write", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, miseCallsOn, runPieOn, sourceDirectory } =
            yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const claudeDirectory = path.join(home, '.claude')

          yield* prepareBox(home)
          yield* writeOwnClaudeSettings(home, { theme: 'dark' })
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* writeClaudeState(home, ['fff', 'docs', 'mine'])
          yield* writeFilesUnder(claudeDirectory, { 'skills/mine/SKILL.md': 'mine' })
          yield* commitToConfigSource(
            sourceDirectory,
            {
              'recipes/personal.toml':
                'label = "Personal"\nenvironment = "personal"\nmcp = ["fff"]\n',
            },
            [],
          )
          yield* runPieOn('pod', ['pod', 'up'])

          const remainingClaudeFiles = yield* snapshotDirectory(claudeDirectory)
          const handoffStillThere = yield* fileSystem.exists(
            path.join(claudeDirectory, 'skills', 'handoff'),
          )
          const remainingHomeFiles = yield* snapshotHomeFiles(home)

          expect(Record.map(remainingHomeFiles, ({ text }) => text)).toEqual({
            '.profile': MISE_PROFILE_BLOCK,
            '.zshrc': MISE_ZSHRC_BLOCK,
          })
          expect(
            Record.map(remainingClaudeFiles, ({ text }) => withInstructionBulletsMasked(text)),
          ).toEqual({
            'CLAUDE.md': CLAUDE_INSTRUCTIONS_BLOCK,
            'settings.json': '{\n  "theme": "dark"\n}\n',
            'skills/mine/SKILL.md': 'mine',
          })
          expect(handoffStillThere).toBe(false)
          expect(miseCallsOn('pod')).toEqual([
            ...TOOL_AND_TASK_CALLS,
            ...MCP_ADD_CALLS,
            ...TOOL_AND_TASK_CALLS,
            'exec -- claude mcp remove --scope user docs',
          ])
        }),
      ),
    ))

  test('an edited MCP server is removed and added again, and an unchanged one is left alone', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { homeOf, miseCallsOn, runPieOn, sourceDirectory } =
            yield* startPods(temporaryDirectory)
          const home = homeOf('pod')

          yield* prepareBox(home)
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* writeClaudeState(home, ['fff', 'docs'])
          yield* commitToConfigSource(
            sourceDirectory,
            { 'mcp/docs.toml': 'url = "https://docs.example/v2"\n' },
            [],
          )
          yield* runPieOn('pod', ['pod', 'up'])

          expect(miseCallsOn('pod')).toEqual([
            ...TOOL_AND_TASK_CALLS,
            ...MCP_ADD_CALLS,
            ...TOOL_AND_TASK_CALLS,
            'exec -- claude mcp remove --scope user docs',
            'exec -- claude mcp add-json --scope user docs {"type":"http","url":"https://docs.example/v2"}',
          ])
        }),
      ),
    ))

  test('a run dying while re-adding an edited MCP server adds it again on the next run', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { homeOf, miseCallsOn, runPieOn, sourceDirectory } =
            yield* startPods(temporaryDirectory)
          const home = homeOf('pod')

          yield* prepareBox(home)
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* writeClaudeState(home, ['fff', 'docs'])
          yield* commitToConfigSource(
            sourceDirectory,
            { 'mcp/docs.toml': 'url = "https://docs.example/v2"\n' },
            [],
          )
          yield* Effect.flip(
            runPieOn('pod', ['pod', 'up'], PERSONAL_POD_TAGS, { failingRun: 'add-json' }),
          )
          yield* runPieOn('pod', ['pod', 'up'])

          expect(Arr.takeRight(miseCallsOn('pod'), 2)).toEqual([
            'exec -- claude mcp remove --scope user docs',
            'exec -- claude mcp add-json --scope user docs {"type":"http","url":"https://docs.example/v2"}',
          ])
        }),
      ),
    ))

  test('every command pie runs gets stdin closed, git included', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { homeOf, runPieOn, spawnedCommands } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('pod'))
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])

          expect(
            pipe(
              spawnedCommands,
              Arr.map(({ programName }) => programName),
              Arr.dedupe,
            ),
          ).toEqual(['git', 'mise'])
          expect(
            pipe(
              spawnedCommands,
              Arr.map(({ stdin }) => stdin),
              Arr.dedupe,
            ),
          ).toEqual(['ignore'])
        }),
      ),
    ))

  test("a skill written by a run that died stays pie's on the next run", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const skillPath = path.join(home, '.claude', 'skills', 'review', 'SKILL.md')

          yield* prepareBox(home)
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* writeClaudeState(home, ['fff', 'docs'])
          yield* commitToConfigSource(
            sourceDirectory,
            {
              'skills/review/SKILL.md': '---\nname: review\ndescription: reviews\n---\nReview.\n',
              'recipes/personal.toml': SEED_CONFIG_FILES['recipes/personal.toml'].replace(
                'skills = ["handoff"]',
                'skills = ["handoff", "review"]',
              ),
              'mcp/docs.toml': 'url = "https://docs.example/v2"\n',
            },
            [],
          )
          yield* Effect.flip(
            runPieOn('pod', ['pod', 'up'], PERSONAL_POD_TAGS, { failingRun: 'add-json' }),
          )

          const skillWrittenByTheDeadRun = yield* fileSystem.exists(skillPath)

          yield* runPieOn('pod', ['pod', 'up'])

          expect(skillWrittenByTheDeadRun).toBe(true)
          expect(yield* fileSystem.exists(skillPath)).toBe(true)
        }),
      ),
    ))

  test('a home file switching from copied to appended ends up holding its block', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('pod'))
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* commitToConfigSource(
            sourceDirectory,
            {
              'recipes/personal.toml': SEED_CONFIG_FILES['recipes/personal.toml'].replace(
                'home = ["shell", ',
                'home = [{ name = "shell", mode = "append" }, ',
              ),
            },
            [],
          )
          yield* runPieOn('pod', ['pod', 'up'])

          expect(
            yield* fileSystem.readFileString(path.join(homeOf('pod'), '.config', 'starship.toml')),
          ).toBe('# >>> pie: home/shell >>>\nadd_newline = false\n# <<< pie: home/shell <<<\n')
        }),
      ),
    ))

  test('a failed fetch of the config checkout names the integration and its tag', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const { homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('pod'))
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* fileSystem.rename(sourceDirectory, `${sourceDirectory}-moved`)

          const failure = yield* Effect.flip(runPieOn('pod', ['pod', 'up']))

          expect(failure).toBeInstanceOf(RepositoryUnreachable)
          expect(failure).toMatchObject({
            repositoryName: CONFIG_REPOSITORY,
            integrationName: 'github',
            integrationTag: 'pie',
          })
        }),
      ),
    ))

  test("Claude's instructions name the manifests where this box's XDG_CONFIG_HOME puts them", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const configHome = path.join(temporaryDirectory, 'elsewhere')

          yield* prepareBox(home)
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY], PERSONAL_POD_TAGS, {
            environment: { XDG_CONFIG_HOME: configHome },
          })

          const instructions = yield* fileSystem.readFileString(
            path.join(home, '.claude', 'CLAUDE.md'),
          )
          const pieConfigFileNames = yield* fileSystem.readDirectory(path.join(configHome, 'pie'))

          expect(instructions).toContain(`\`${configHome}/pie/*manifest.json\``)
          expect(pieConfigFileNames).toContain('manifest.json')
        }),
      ),
    ))

  test("the config checkout follows the remote's renamed default branch", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { homeOf, output, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('pod'))
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* runGit(['-C', sourceDirectory, 'branch', '-m', 'renamed-default'])
          yield* commitToConfigSource(sourceDirectory, { 'tasks/later': '#!/bin/sh\n' }, [])
          yield* runPieOn('pod', ['pod', 'up'])

          const headCommit = yield* runGit(['-C', sourceDirectory, 'rev-parse', 'HEAD'])

          expect(Arr.last(output.stdout)).toEqual(
            Option.some(`Applied recipe personal at config commit ${headCommit.slice(0, 7)}.`),
          )
        }),
      ),
    ))

  test("fails before changing anything when a skill, an MCP or a home file of the same name isn't pie's", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, miseCallsOn, runPieOn } = yield* startPods(temporaryDirectory)
          const skillHome = homeOf('skill-box')
          const mcpHome = homeOf('mcp-box')
          const homeFileHome = homeOf('home-box')
          const ownStarshipPath = path.join(homeFileHome, '.config', 'starship.toml')
          const ownSkillPath = path.join(skillHome, '.claude', 'skills', 'handoff', 'SKILL.md')

          yield* Effect.forEach([skillHome, mcpHome, homeFileHome], prepareBox, { discard: true })
          yield* writeFilesUnder(homeFileHome, { '.config/starship.toml': 'mine' })
          yield* writeFilesUnder(skillHome, { '.claude/skills/handoff/SKILL.md': 'mine' })
          yield* writeClaudeState(mcpHome, ['fff'])

          const skillClash = yield* Effect.flip(
            runPieOn('skill-box', ['pod', 'up', CONFIG_REPOSITORY]),
          )
          const mcpClash = yield* Effect.flip(runPieOn('mcp-box', ['pod', 'up', CONFIG_REPOSITORY]))
          const homeFileClash = yield* Effect.flip(
            runPieOn('home-box', ['pod', 'up', CONFIG_REPOSITORY]),
          )
          const skillBoxAgentsWritten = yield* fileSystem.exists(
            path.join(skillHome, '.claude', 'agents'),
          )
          const mcpBoxClaudeWritten = yield* fileSystem.exists(path.join(mcpHome, '.claude'))
          const miseCalls = Arr.flatMap(['skill-box', 'mcp-box', 'home-box'], miseCallsOn)

          expect(skillClash).toEqual(
            new ClaudeEntryNotPies({ entryPath: path.dirname(ownSkillPath) }),
          )
          expect(mcpClash).toEqual(new McpServerNotPies({ mcpName: 'fff' }))
          expect(homeFileClash).toEqual(
            new HomeFileNotPies({ filePath: ownStarshipPath, homeName: 'shell' }),
          )
          expect([skillBoxAgentsWritten, mcpBoxClaudeWritten]).toEqual([false, false])
          expect(miseCalls).toEqual([])
        }),
      ),
    ))

  test('a VM without exactly one pie-recipe tag fails, naming its tags', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { runPieOn } = yield* startPods(temporaryDirectory)
          const untagged = yield* Effect.flip(
            runPieOn('untagged', ['pod', 'up', CONFIG_REPOSITORY], ['pie']),
          )
          const doubleTagged = yield* Effect.flip(
            runPieOn('double', ['pod', 'up', CONFIG_REPOSITORY], ['pie-recipe-a', 'pie-recipe-b']),
          )
          const nameless = yield* Effect.flip(
            runPieOn('nameless', ['pod', 'up', CONFIG_REPOSITORY], ['pie', 'pie-recipe-']),
          )

          expect(untagged).toEqual(new RecipeTagMissing({ vmTags: ['pie'] }))
          expect(nameless).toEqual(new RecipeTagMissing({ vmTags: ['pie', 'pie-recipe-'] }))
          expect(doubleTagged).toEqual(
            new RecipeTagsConflict({ recipeTags: ['pie-recipe-a', 'pie-recipe-b'] }),
          )
        }),
      ),
    ))

  test("a config repo that isn't <org>/<repo>, given or remembered, fails before pie fetches anything", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const rememberedPath = path.join(home, '.config', 'pie', 'config-repo')

          yield* prepareBox(home)

          const given = yield* Effect.flip(runPieOn('pod', ['pod', 'up', '../..']))

          yield* writeFilesUnder(home, { '.config/pie/config-repo': '../..\n' })

          const remembered = yield* Effect.flip(runPieOn('pod', ['pod', 'up']))
          const cacheWritten = yield* fileSystem.exists(path.join(home, '.cache'))

          expect(given).toBeInstanceOf(CliError.ShowHelp)
          expect(remembered).toEqual(
            new RememberedConfigRepositoryInvalid({
              filePath: rememberedPath,
              rememberedText: '../..',
            }),
          )
          expect(cacheWritten).toBe(false)
        }),
      ),
    ))

  test("a VM missing a recipe's tags fails with the ssh exe.dev tag line that adds them, and writes nothing", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, miseCallsOn, runPieOn, sourceDirectory } =
            yield* startPods(temporaryDirectory)
          const home = homeOf('work-box')

          yield* prepareBox(home)
          yield* commitToConfigSource(
            sourceDirectory,
            { 'recipes/personal.toml': WORK_RECIPE_TOML },
            [],
          )

          const error = yield* Effect.flip(
            runPieOn(
              'work-box',
              ['pod', 'up', CONFIG_REPOSITORY],
              [...PERSONAL_POD_TAGS, 'work-gh'],
            ),
          )
          const writtenHomePaths = yield* Effect.filter(
            [...HOME_FILE_PATHS, '.claude', '.config/mise'],
            (homePath) => fileSystem.exists(path.join(home, homePath)),
          )

          expect(error).toEqual(
            new VmTagsMissing({
              vmName: 'work-box',
              recipeName: 'personal',
              missingTags: ['work-gcp'],
            }),
          )
          expect(error.message).toContain('`ssh exe.dev tag work-box work-gcp`')
          expect(writtenHomePaths).toEqual([])
          expect(miseCallsOn('work-box')).toEqual([])
        }),
      ),
    ))

  test("a VM carrying every one of a recipe's tags goes through", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { homeOf, output, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('work-box'))
          yield* commitToConfigSource(
            sourceDirectory,
            { 'recipes/personal.toml': WORK_RECIPE_TOML },
            [],
          )
          yield* runPieOn(
            'work-box',
            ['pod', 'up', CONFIG_REPOSITORY],
            [...PERSONAL_POD_TAGS, 'work-gcp', 'work-gh'],
          )

          const headCommit = yield* runGit(['-C', sourceDirectory, 'rev-parse', 'HEAD'])

          expect(output.stdout).toEqual([
            `Applied recipe personal at config commit ${headCommit.slice(0, 7)}.`,
          ])
        }),
      ),
    ))

  test('a repository clones through the integration it names, and one pie cannot clone fails, naming the integration and its tag', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const { homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('pod'))
          yield* runGit([
            'init',
            '--quiet',
            path.join(temporaryDirectory, 'hapana-gh-git', 'hapana-hub', 'hapana-gcp.git'),
          ])
          yield* commitToConfigSource(
            sourceDirectory,
            {
              'recipes/personal.toml':
                'label = "Personal"\nenvironment = "personal"\nrepositories = [\n  { repo = "hapana-hub/hapana-gcp", integration = "hapana-gh-git" },\n  { repo = "hapana-hub/missing", integration = "hapana-gh-git" },\n]\n',
            },
            [],
          )

          const configRepositoryFailure = yield* Effect.flip(
            runPieOn('pod', ['pod', 'up', 'jliocsar/missing']),
          )
          const recipeRepositoryFailure = yield* Effect.flip(
            runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY]),
          )
          const clonedRemoteUrl = yield* runGit([
            '-C',
            path.join(homeOf('pod'), 'workspace', 'hapana-hub', 'hapana-gcp'),
            'remote',
            'get-url',
            'origin',
          ])

          expect(Str.trim(clonedRemoteUrl)).toBe(
            'https://hapana-gh-git.int.exe.xyz/hapana-hub/hapana-gcp.git',
          )
          expect([configRepositoryFailure, recipeRepositoryFailure]).toMatchObject([
            {
              repositoryName: 'jliocsar/missing',
              integrationName: 'github',
              integrationTag: 'pie',
            },
            {
              repositoryName: 'hapana-hub/missing',
              integrationName: 'hapana-gh-git',
              integrationTag: 'pie-recipe-personal',
            },
          ])
          expect(recipeRepositoryFailure).toBeInstanceOf(RepositoryUnreachable)
          expect(recipeRepositoryFailure.message).toContain(
            'check that the hapana-gh-git integration is attached to tag:pie-recipe-personal',
          )
        }),
      ),
    ))
})

describe('pie pod up on a box without mise', () => {
  test('downloads the installer and runs it before installing the tools', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { miseCallsOn, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* commitToConfigSource(
            sourceDirectory,
            { 'recipes/personal.toml': 'label = "Personal"\nenvironment = "personal"\n' },
            [],
          )
          yield* runPieOn('fresh-box', ['pod', 'up', CONFIG_REPOSITORY])

          const [installerDownload, ...laterCalls] = miseCallsOn('fresh-box')

          expect(installerDownload).toContain('https://mise.run')
          expect(laterCalls).toEqual(['sh <temporary>/install-mise.sh', ...TOOL_AND_TASK_CALLS])
        }),
      ),
    ))
})

describe('pie sync and pie check', () => {
  test('sync writes the names on disk into the schemas, and check accepts the result', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const path = yield* Path.Path
          const { output, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* runPieOn('laptop', ['sync', sourceDirectory])
          yield* runPieOn('laptop', ['check', sourceDirectory])

          const recipeDefinitions = yield* readSchemaDefinitions(sourceDirectory, 'recipe')
          const environmentDefinitions = yield* readSchemaDefinitions(
            sourceDirectory,
            'environment',
          )
          const mcpDefinitions = yield* readSchemaDefinitions(sourceDirectory, 'mcp')

          expect(recipeDefinitions).toEqual({
            environment: { type: 'string', enum: ['personal'] },
            agent: { type: 'string', enum: ['oracle', 'unused'] },
            settings: { type: 'string', enum: ['default'] },
            claude_md: { type: 'string', enum: ['gcp', 'work'] },
            skill: { type: 'string', enum: ['handoff'] },
            mcp: { type: 'string', enum: ['docs', 'fff'] },
            home: { type: 'string', enum: ['shell', 'zsh'] },
          })
          expect(environmentDefinitions).toEqual({
            environment: { type: 'string', enum: ['personal'] },
            task: { type: 'string', enum: ['workspace'] },
          })
          expect(mcpDefinitions).toEqual({})
          expect(output.stdout).toEqual([
            `Synced ${path.join(sourceDirectory, '.pie/schema')}.`,
            'Config is valid.',
          ])
        }),
      ),
    ))

  test.each([
    {
      description: 'a TOML file without its #:schema line',
      overrides: { 'mcp/fff.toml': 'command = "fff-mcp"\n' },
      errorClass: SchemaLineMissing,
      filePath: 'mcp/fff.toml',
    },
    {
      description: 'a skill added without a sync',
      overrides: { 'skills/review/SKILL.md': '---\nname: review\ndescription: reviews\n---\n' },
      errorClass: SchemaFileStale,
      filePath: '.pie/schema/recipe.json',
    },
    {
      description: "a recipe listing a skill that doesn't exist",
      overrides: {
        'recipes/personal.toml': SEED_CONFIG_FILES['recipes/personal.toml'].replace(
          '"handoff"',
          '"handof"',
        ),
      },
      errorClass: ConfigReferenceMissing,
      filePath: 'recipes/personal.toml',
    },
  ])('check refuses $description, naming the file', ({ overrides, errorClass, filePath }) =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* runPieOn('laptop', ['sync', sourceDirectory])
          yield* commitToConfigSource(sourceDirectory, overrides, [])

          const error = yield* Effect.flip(runPieOn('laptop', ['check', sourceDirectory]))

          expect(error).toBeInstanceOf(errorClass)
          expect(error.message).toStartWith(filePath)
        }),
      ),
    ),
  )
})
