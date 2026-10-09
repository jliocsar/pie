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
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { pie } from './Cli.ts'
import { SchemaFileStale, SchemaLineMissing } from './commands/Check.ts'
import { RoutineNotFound, RoutineRecipeMismatch } from './commands/Pod.ts'
import {
  BOOT_ID_PATH,
  RoutineRunUnsuccessful,
  RunLockJson,
  RunLogLineUnreadable,
} from './commands/Routine.ts'
import { configFilePathOf, ConfigReferenceMissing, type TomlKind } from './ConfigRepo.ts'
import { ClaudeEntryNotPies, claudeInstructionsOf, McpServerNotPies } from './Claude.ts'
import {
  RecipeTagMissing,
  RecipeTagsConflict,
  REFLECTION_TAGS_URL,
  RepositoryUnreachable,
} from './ExeDev.ts'
import { runGit } from './Git.ts'
import { HomeFileNotPies } from './Pod.ts'
import {
  commitToConfigSource,
  CONFIG_REPOSITORY,
  inFreshDirectory,
  makeConfigSource,
  SEED_CONFIG_FILES,
} from './test/TestPie.ts'

const FAKE_MISE_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/mise-calls"
if [ -f "$HOME/claude-hangs" ]; then
  trap '' TERM
  sleep 30 &
  echo $! > "$HOME/claude-child"
  wait
fi
exit "$(cat "$HOME/claude-exit" 2>/dev/null || echo 0)"
`

const FAKE_CRONTAB_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/crontab-calls"
case "$1" in
  -l) if [ -f "$HOME/crontab" ]; then cat "$HOME/crontab"; else echo "no crontab for pod" >&2; exit 1; fi ;;
  -) cat > "$HOME/crontab" ;;
esac
`

const EXECUTABLE_FILE_MODE = 0o755
const PERMISSION_BITS = 0o777
const PERSONAL_POD_TAGS = ['pie', 'pie-recipe-personal']
const CHECKED_OUT_REPOSITORY_DIRECTORIES = ['jliocsar/pie', 'nidus']
const TASK_PATH_PATTERN = /^exec -- \/\S*\/(?<taskName>[^/\s]+)$/u
const TOOL_AND_TASK_CALLS = ['install', 'exec -- <tasks>/workspace']
const UUID_PATTERN = /[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}/gu

const TRIAGE_CLAUDE_CALL =
  'exec -- claude -p Triage issues opened since your last run. --session-id <uuid> --model opus'

const MCP_ADD_CALLS = [
  'exec -- claude mcp add-json --scope user fff {"type":"stdio","command":"fff-mcp","args":[]}',
  'exec -- claude mcp add-json --scope user docs {"type":"http","url":"https://docs.example/mcp"}',
]

const MISE_PROFILE_BLOCK =
  '# >>> pie: mise >>>\nexport PATH="$HOME/.local/share/mise/shims:$PATH"\n# <<< pie: mise <<<\n'

const MISE_ZSHRC_BLOCK =
  '# >>> pie: mise >>>\neval "$($HOME/.local/bin/mise activate zsh)"\n# <<< pie: mise <<<\n'

const CLAUDE_INSTRUCTIONS_BLOCK = `<!-- >>> pie >>> -->\n${claudeInstructionsOf('personal', CONFIG_REPOSITORY)}<!-- <<< pie <<< -->\n`
const HOME_FILE_PATHS = ['.profile', '.zshrc', '.config/starship.toml']

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

const reflectionAnswering = (vmTags: readonly string[]) =>
  Object.assign(
    (input: string | URL | Request) =>
      Promise.resolve(
        String(input instanceof Request ? input.url : input) === REFLECTION_TAGS_URL
          ? Response.json({ tags: vmTags })
          : new Response(null, { status: 404 }),
      ),
    { preconnect: globalThis.fetch.preconnect },
  )

const startPods = Effect.fn('startPods')(function* (temporaryDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const crontabPath = path.join(temporaryDirectory, 'crontab')
  const { githubDirectory, sourceDirectory } = yield* makeConfigSource(temporaryDirectory)
  const output = capturingConsole()
  const homeOf = (machineName: string) => path.join(temporaryDirectory, machineName)

  yield* fileSystem.writeFileString(crontabPath, FAKE_CRONTAB_SCRIPT, {
    mode: EXECUTABLE_FILE_MODE,
  })

  const runPieOn = (
    machineName: string,
    commandLine: readonly string[],
    vmTags: readonly string[] = PERSONAL_POD_TAGS,
  ) =>
    Command.runWith(pie, { version: '0.0.0-test' })(commandLine).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, reflectionAnswering(vmTags)),
      Effect.provideService(Console.Console, output.console),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: {
            HOME: homeOf(machineName),
            PIE_GITHUB_URL: githubDirectory,
            PIE_CRONTAB: crontabPath,
          },
        }),
      ),
    )

  return { sourceDirectory, output, homeOf, runPieOn }
})

const prepareBox = Effect.fn('prepareBox')(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const misePath = path.join(home, '.local', 'bin', 'mise')

  yield* fileSystem.makeDirectory(path.dirname(misePath), { recursive: true })
  yield* fileSystem.writeFileString(misePath, FAKE_MISE_SCRIPT, { mode: EXECUTABLE_FILE_MODE })
  yield* Effect.forEach(
    CHECKED_OUT_REPOSITORY_DIRECTORIES,
    (repositoryDirectory) =>
      fileSystem.makeDirectory(path.join(home, 'workspace', repositoryDirectory), {
        recursive: true,
      }),
    { discard: true },
  )
})

const readMiseCalls = Effect.fn('readMiseCalls')(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const miseCallsPath = path.join(home, 'mise-calls')

  if (yield* fileSystem.exists(miseCallsPath)) {
    return pipe(
      (yield* fileSystem.readFileString(miseCallsPath)).split('\n'),
      Arr.filter(Boolean),
      Arr.map((miseCall) => miseCall.replace(TASK_PATH_PATTERN, 'exec -- <tasks>/$<taskName>')),
    )
  }

  return []
})

const readLinesIfPresent = Effect.fn('readLinesIfPresent')(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem

  if (yield* fileSystem.exists(filePath)) {
    return Arr.filter((yield* fileSystem.readFileString(filePath)).split('\n'), Boolean)
  }

  return []
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

const snapshotHomeFiles = Effect.fn('snapshotHomeFiles')(function* (home: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const existingHomeFilePaths = yield* Effect.filter(HOME_FILE_PATHS, (homeFilePath) =>
    fileSystem.exists(path.join(home, homeFilePath)),
  )
  const homeFiles = yield* Effect.forEach(existingHomeFilePaths, (homeFilePath) =>
    Effect.all({
      text: fileSystem.readFileString(path.join(home, homeFilePath)),
      fileInfo: fileSystem.stat(path.join(home, homeFilePath)),
    }).pipe(
      Effect.map(
        ({ text, fileInfo }) =>
          [
            homeFilePath,
            {
              text,
              mode: fileInfo.mode & PERMISSION_BITS,
              modifiedAt: Option.getOrNull(fileInfo.mtime),
            },
          ] as const,
      ),
    ),
  )

  return Record.fromEntries(homeFiles)
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
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const settingsPath = path.join(home, '.claude', 'settings.json')

  yield* fileSystem.makeDirectory(path.dirname(settingsPath), { recursive: true })
  yield* fileSystem.writeFileString(
    settingsPath,
    yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(claudeSettings),
  )
})

const readSchemaDefinitions = Effect.fn('readSchemaDefinitions')(function* (
  configDirectory: string,
  tomlKind: TomlKind,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const schemaText = yield* fileSystem.readFileString(
    path.join(configDirectory, configFilePathOf.schema(tomlKind)),
  )
  const { $defs } = yield* Schema.decodeEffect(
    Schema.fromJsonString(Schema.Struct({ $defs: Schema.Unknown })),
  )(schemaText)

  return $defs
})

const startRoutineBox = Effect.fn('startRoutineBox')(function* (
  temporaryDirectory: string,
  routineConfigFiles: Record.ReadonlyRecord<string, string>,
  routineNames: readonly string[],
) {
  const path = yield* Path.Path
  const pods = yield* startPods(temporaryDirectory)
  const home = pods.homeOf('pod')
  const routineTags = [
    ...PERSONAL_POD_TAGS,
    ...Arr.map(routineNames, (routineName) => `pie-routine-${routineName}`),
  ]

  yield* prepareBox(home)
  yield* commitToConfigSource(pods.sourceDirectory, routineConfigFiles, []).pipe(
    Effect.when(Effect.succeed(!Record.isEmptyRecord(routineConfigFiles))),
  )
  yield* pods.runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY], routineTags)

  const fileSystem = yield* FileSystem.FileSystem

  yield* fileSystem.remove(path.join(home, 'mise-calls'))

  const routineStateDirectory = path.join(home, '.local', 'state', 'pie', 'routines')
  const runRoutine = (routineName: string) =>
    pods.runPieOn('pod', ['routine', 'run', routineName], routineTags)
  const readRunLog = (routineName: string) =>
    readLinesIfPresent(path.join(routineStateDirectory, `${routineName}.jsonl`)).pipe(
      Effect.flatMap((runLogLines) =>
        Effect.forEach(runLogLines, (runLogLine) =>
          Schema.decodeEffect(
            Schema.fromJsonString(
              Schema.Struct({
                run: Schema.String,
                event: Schema.String,
                outcome: Schema.optionalKey(Schema.String),
              }),
            ),
          )(runLogLine),
        ),
      ),
    )
  const readClaudeCalls = readMiseCalls(home).pipe(
    Effect.map(Arr.map((miseCall) => miseCall.replace(UUID_PATTERN, '<uuid>'))),
  )
  const runLockPathOf = (routineName: string) =>
    path.join(routineStateDirectory, `${routineName}.lock`)

  return {
    ...pods,
    home,
    routineStateDirectory,
    runRoutine,
    readRunLog,
    readClaudeCalls,
    runLockPathOf,
  }
})

afterAll(() => bunServicesRuntime.dispose())

describe('pie pod up', () => {
  test('installs the tools, runs the tasks, writes ~/.claude, adds MCPs through claude, and a rerun changes nothing', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { output, homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const claudeDirectory = path.join(home, '.claude')
          const manifestPath = path.join(home, '.config', 'pie', 'manifest.json')
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

          const firstMiseCalls = yield* readMiseCalls(home)
          const firstSnapshot = yield* snapshotDirectory(claudeDirectory)
          const firstHomeSnapshot = yield* snapshotHomeFiles(home)
          const firstManifestModifiedAt = (yield* fileSystem.stat(manifestPath)).mtime

          yield* runPieOn('pod', ['pod', 'up'])

          const secondMiseCalls = yield* readMiseCalls(home)
          const crontabCalls = yield* readLinesIfPresent(path.join(home, 'crontab-calls'))
          const secondSnapshot = yield* snapshotDirectory(claudeDirectory)
          const secondHomeSnapshot = yield* snapshotHomeFiles(home)
          const manifestModifiedAt = (yield* fileSystem.stat(manifestPath)).mtime
          const miseConfig = yield* fileSystem.readFileString(
            path.join(home, '.config', 'mise', 'conf.d', 'pie.toml'),
          )

          expect(firstMiseCalls).toEqual([...TOOL_AND_TASK_CALLS, ...MCP_ADD_CALLS])
          expect(Record.map(firstSnapshot, ({ text, mode }) => ({ text, mode }))).toEqual({
            'CLAUDE.md': { text: `# stock\n${CLAUDE_INSTRUCTIONS_BLOCK}`, mode: 0o644 },
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
          expect(crontabCalls).toEqual(['-l', '-l'])
          expect(miseConfig).toBe(
            '[tools]\n"node" = { "version" = "24.19.0" }\n"github:dmtrKovalenko/fff" = { "version" = "0.10.6", "matching" = "fff-mcp", "bin" = "fff-mcp" }\n[env]\n"GH_HOST" = "github.int.exe.xyz"\n',
          )
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
          expect(manifestModifiedAt).toEqual(firstManifestModifiedAt)
          expect(output.stdout).toEqual(
            Arr.replicate(`Applied recipe personal at config commit ${abbreviatedCommit}.`, 2),
          )
        }),
      ),
    ))

  test("removes what a changed recipe dropped, and leaves what pie didn't write", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const claudeDirectory = path.join(home, '.claude')
          const ownSkillPath = path.join(claudeDirectory, 'skills', 'mine', 'SKILL.md')

          yield* prepareBox(home)
          yield* writeOwnClaudeSettings(home, { theme: 'dark' })
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY])
          yield* writeClaudeState(home, ['fff', 'docs', 'mine'])
          yield* fileSystem.makeDirectory(path.dirname(ownSkillPath), { recursive: true })
          yield* fileSystem.writeFileString(ownSkillPath, 'mine')
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
          const miseCalls = yield* readMiseCalls(home)
          const remainingHomeFiles = yield* snapshotHomeFiles(home)

          expect(Record.map(remainingHomeFiles, ({ text }) => text)).toEqual({
            '.profile': MISE_PROFILE_BLOCK,
            '.zshrc': MISE_ZSHRC_BLOCK,
          })
          expect(Record.map(remainingClaudeFiles, ({ text }) => text)).toEqual({
            'CLAUDE.md': CLAUDE_INSTRUCTIONS_BLOCK,
            'settings.json': '{\n  "theme": "dark"\n}\n',
            'skills/mine/SKILL.md': 'mine',
          })
          expect(handoffStillThere).toBe(false)
          expect(miseCalls).toEqual([
            ...TOOL_AND_TASK_CALLS,
            ...MCP_ADD_CALLS,
            ...TOOL_AND_TASK_CALLS,
            'exec -- claude mcp remove --scope user docs',
          ])
        }),
      ),
    ))

  test("fails before changing anything when a skill, an MCP or a home file of the same name isn't pie's", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn } = yield* startPods(temporaryDirectory)
          const skillHome = homeOf('skill-box')
          const mcpHome = homeOf('mcp-box')
          const homeFileHome = homeOf('home-box')
          const ownStarshipPath = path.join(homeFileHome, '.config', 'starship.toml')
          const ownSkillPath = path.join(skillHome, '.claude', 'skills', 'handoff', 'SKILL.md')

          yield* Effect.forEach([skillHome, mcpHome, homeFileHome], prepareBox, { discard: true })
          yield* fileSystem.makeDirectory(path.dirname(ownStarshipPath), { recursive: true })
          yield* fileSystem.writeFileString(ownStarshipPath, 'mine')
          yield* fileSystem.makeDirectory(path.dirname(ownSkillPath), { recursive: true })
          yield* fileSystem.writeFileString(ownSkillPath, 'mine')
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
          const miseCalls = [
            ...(yield* readMiseCalls(skillHome)),
            ...(yield* readMiseCalls(mcpHome)),
            ...(yield* readMiseCalls(homeFileHome)),
          ]

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

  test("schedules a VM's routines in pie's crontab block, rewriting it only on change", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn } = yield* startPods(temporaryDirectory)
          const home = homeOf('pod')
          const crontabPath = path.join(home, 'crontab')
          const routineTags = [...PERSONAL_POD_TAGS, 'pie-routine-triage']

          yield* prepareBox(home)
          yield* fileSystem.writeFileString(crontabPath, 'MAILTO=""\n')
          yield* runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY], routineTags)

          const scheduledCrontab = yield* fileSystem.readFileString(crontabPath)

          yield* runPieOn('pod', ['pod', 'up'], routineTags)

          const crontabCallsAfterRerun = yield* readLinesIfPresent(path.join(home, 'crontab-calls'))

          yield* runPieOn('pod', ['pod', 'up'])

          expect(scheduledCrontab).toBe(
            'MAILTO=""\n# >>> pie: routines >>>\n*/15 * * * * /usr/local/bin/pie routine run triage\n# <<< pie: routines <<<\n',
          )
          expect(crontabCallsAfterRerun).toEqual(['-l', '-', '-l'])
          expect(yield* fileSystem.readFileString(crontabPath)).toBe('MAILTO=""\n')
        }),
      ),
    ))

  test('a routine tag naming a missing routine, or one for another recipe, fails before anything changes', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { homeOf, runPieOn, sourceDirectory } = yield* startPods(temporaryDirectory)

          yield* Effect.forEach([homeOf('missing-box'), homeOf('mismatch-box')], prepareBox, {
            discard: true,
          })
          yield* commitToConfigSource(
            sourceDirectory,
            {
              'recipes/work.toml': SEED_CONFIG_FILES['recipes/personal.toml'],
              'routines/standup.toml': SEED_CONFIG_FILES['routines/triage.toml'].replace(
                '"personal"',
                '"work"',
              ),
            },
            [],
          )

          const missingRoutine = yield* Effect.flip(
            runPieOn(
              'missing-box',
              ['pod', 'up', CONFIG_REPOSITORY],
              [...PERSONAL_POD_TAGS, 'pie-routine-nightly'],
            ),
          )
          const mismatchedRoutine = yield* Effect.flip(
            runPieOn(
              'mismatch-box',
              ['pod', 'up', CONFIG_REPOSITORY],
              [...PERSONAL_POD_TAGS, 'pie-routine-standup'],
            ),
          )
          const miseCalls = [
            ...(yield* readMiseCalls(homeOf('missing-box'))),
            ...(yield* readMiseCalls(homeOf('mismatch-box'))),
          ]

          expect(missingRoutine).toEqual(new RoutineNotFound({ routineName: 'nightly' }))
          expect(mismatchedRoutine).toEqual(
            new RoutineRecipeMismatch({
              routineName: 'standup',
              routineRecipeName: 'work',
              vmRecipeName: 'personal',
            }),
          )
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

          expect(untagged).toEqual(new RecipeTagMissing({ vmTags: ['pie'] }))
          expect(doubleTagged).toEqual(
            new RecipeTagsConflict({ recipeTags: ['pie-recipe-a', 'pie-recipe-b'] }),
          )
        }),
      ),
    ))

  test('a repository pie cannot clone fails, naming the tag its integration attaches to', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn } = yield* startPods(temporaryDirectory)

          yield* prepareBox(homeOf('pod'))
          yield* fileSystem.remove(path.join(homeOf('pod'), 'workspace', 'jliocsar', 'pie'), {
            recursive: true,
          })

          const configRepositoryFailure = yield* Effect.flip(
            runPieOn('pod', ['pod', 'up', 'jliocsar/missing']),
          )
          const recipeRepositoryFailure = yield* Effect.flip(
            runPieOn('pod', ['pod', 'up', CONFIG_REPOSITORY]),
          )

          expect([configRepositoryFailure, recipeRepositoryFailure]).toMatchObject([
            { repositoryName: 'jliocsar/missing', integrationTag: 'pie' },
            { repositoryName: 'jliocsar/pie', integrationTag: 'pie-recipe-personal' },
          ])
          expect(recipeRepositoryFailure).toBeInstanceOf(RepositoryUnreachable)
        }),
      ),
    ))
})

describe('pie routine run', () => {
  test('runs claude through mise with the session id, and logs the run as started then succeeded', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const { output, runRoutine, readRunLog, readClaudeCalls, runLockPathOf } =
            yield* startRoutineBox(temporaryDirectory, {}, ['triage'])

          yield* runRoutine('triage')

          const runLog = yield* readRunLog('triage')

          expect(yield* readClaudeCalls).toEqual([TRIAGE_CLAUDE_CALL])
          expect(runLog).toMatchObject([
            { event: 'started' },
            { event: 'finished', outcome: 'succeeded' },
          ])
          expect(runLog[0]?.run).toBe(runLog[1]?.run ?? '')
          expect(yield* fileSystem.exists(runLockPathOf('triage'))).toBe(false)
          expect(output.stdout.at(-1)).toStartWith('Routine triage succeeded in session ')
        }),
      ),
    ))

  test('a claude exiting non-zero logs the run as failed and fails pie', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { home, runRoutine, readRunLog } = yield* startRoutineBox(temporaryDirectory, {}, [
            'triage',
          ])

          yield* fileSystem.writeFileString(path.join(home, 'claude-exit'), '3\n')

          const failure = yield* Effect.flip(runRoutine('triage'))

          expect(failure).toBeInstanceOf(RoutineRunUnsuccessful)
          expect(failure).toMatchObject({ routineName: 'triage', outcome: 'failed' })
          expect(yield* readRunLog('triage')).toMatchObject([
            { event: 'started' },
            { event: 'finished', outcome: 'failed' },
          ])
        }),
      ),
    ))

  test('a run past its timeout is killed with everything it started, and logged as timed out', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { home, runRoutine, readRunLog } = yield* startRoutineBox(
            temporaryDirectory,
            {
              'routines/quick.toml': SEED_CONFIG_FILES['routines/triage.toml'].replace(
                '"25 minutes"',
                '"1 second"',
              ),
            },
            ['quick'],
          )

          yield* fileSystem.writeFileString(path.join(home, 'claude-hangs'), '')

          const failure = yield* Effect.flip(runRoutine('quick'))
          const claudeChildPid = Str.trim(
            yield* fileSystem.readFileString(path.join(home, 'claude-child')),
          )

          expect(failure).toMatchObject({ routineName: 'quick', outcome: 'timed-out' })
          expect(yield* readRunLog('quick')).toMatchObject([
            { event: 'started' },
            { event: 'finished', outcome: 'timed-out' },
          ])
          expect(yield* fileSystem.exists(path.join('/proc', claudeChildPid))).toBe(false)
        }),
      ),
    ))

  test('a run while the last one holds the lock is logged as skipped, and runs no claude', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const { routineStateDirectory, runRoutine, readRunLog, readClaudeCalls, runLockPathOf } =
            yield* startRoutineBox(temporaryDirectory, {}, ['triage'])
          const bootId = Str.trim(yield* fileSystem.readFileString(BOOT_ID_PATH))
          const heldRunLock = yield* Schema.encodeEffect(RunLockJson)({
            pid: process.pid,
            runId: 'held',
            bootId,
          })

          yield* fileSystem.makeDirectory(routineStateDirectory, { recursive: true })
          yield* fileSystem.writeFileString(runLockPathOf('triage'), heldRunLock)
          yield* runRoutine('triage')

          expect(yield* readRunLog('triage')).toMatchObject([{ event: 'skipped' }])
          expect(yield* readClaudeCalls).toEqual([])
          expect(yield* fileSystem.readFileString(runLockPathOf('triage'))).toBe(heldRunLock)
        }),
      ),
    ))

  test('a lock left by a run that died is logged as interrupted, then the routine runs', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const { routineStateDirectory, runRoutine, readRunLog, readClaudeCalls, runLockPathOf } =
            yield* startRoutineBox(temporaryDirectory, {}, ['triage'])

          yield* fileSystem.makeDirectory(routineStateDirectory, { recursive: true })
          yield* fileSystem.writeFileString(
            runLockPathOf('triage'),
            yield* Schema.encodeEffect(RunLockJson)({
              pid: process.pid,
              runId: 'died',
              bootId: 'an-earlier-boot',
            }),
          )
          yield* runRoutine('triage')

          expect(yield* readRunLog('triage')).toMatchObject([
            { run: 'died', event: 'finished', outcome: 'interrupted' },
            { event: 'started' },
            { event: 'finished', outcome: 'succeeded' },
          ])
          expect(yield* readClaudeCalls).toEqual([TRIAGE_CLAUDE_CALL])
        }),
      ),
    ))
})

describe('pie routine log', () => {
  test('lists runs newest first, telling a run still going from one that died', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { output, routineStateDirectory, runPieOn, runRoutine, runLockPathOf } =
            yield* startRoutineBox(temporaryDirectory, {}, ['triage'])
          const bootId = Str.trim(yield* fileSystem.readFileString(BOOT_ID_PATH))
          const outcomesOfLastLog = () =>
            pipe(
              output.stdout.at(-1) ?? '',
              (logText) => logText.split('\n'),
              Arr.map((logLine) => logLine.split(/\s{2,}/u)[2] ?? ''),
            )

          yield* runRoutine('triage')
          yield* fileSystem.writeFileString(
            path.join(routineStateDirectory, 'triage.jsonl'),
            '{"run":"held","event":"started","at":"2026-10-09T14:15:00.000Z","sessionId":"held-session"}\n',
            { flag: 'a' },
          )
          yield* fileSystem.writeFileString(
            runLockPathOf('triage'),
            yield* Schema.encodeEffect(RunLockJson)({ pid: process.pid, runId: 'held', bootId }),
          )
          yield* runRoutine('triage')
          yield* runPieOn('pod', ['routine', 'log', 'triage'])

          const outcomesWhileHeld = outcomesOfLastLog()

          yield* fileSystem.remove(runLockPathOf('triage'))
          yield* runPieOn('pod', ['routine', 'log', 'triage'])

          expect(outcomesWhileHeld).toEqual(['outcome', 'skipped', 'running', 'succeeded'])
          expect(outcomesOfLastLog()).toEqual(['outcome', 'skipped', 'interrupted', 'succeeded'])
          expect(output.stdout.at(-1)?.split('\n')[2]).toBe(
            `2026-10-09 14:15:00  ${'-'.padEnd(19)}  interrupted  held-session`,
          )
        }),
      ),
    ))

  test('a line pie did not write fails, naming its line number', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { routineStateDirectory, runPieOn, runRoutine } = yield* startRoutineBox(
            temporaryDirectory,
            {},
            ['triage'],
          )
          const runLogPath = path.join(routineStateDirectory, 'triage.jsonl')

          yield* runRoutine('triage')
          yield* fileSystem.writeFileString(runLogPath, '{"run":"x"}\n', { flag: 'a' })

          const failure = yield* Effect.flip(runPieOn('pod', ['routine', 'log', 'triage']))

          expect(failure).toBeInstanceOf(RunLogLineUnreadable)
          expect(failure).toMatchObject({ filePath: runLogPath, lineNumber: 3 })
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
          const routineDefinitions = yield* readSchemaDefinitions(sourceDirectory, 'routine')

          expect(recipeDefinitions).toEqual({
            environment: { type: 'string', enum: ['personal'] },
            agent: { type: 'string', enum: ['oracle', 'unused'] },
            settings: { type: 'string', enum: ['default'] },
            skill: { type: 'string', enum: ['handoff'] },
            mcp: { type: 'string', enum: ['docs', 'fff'] },
            home: { type: 'string', enum: ['shell', 'zsh'] },
          })
          expect(environmentDefinitions).toEqual({
            environment: { type: 'string', enum: ['personal'] },
            task: { type: 'string', enum: ['workspace'] },
          })
          expect(mcpDefinitions).toEqual({})
          expect(routineDefinitions).toEqual({ recipe: { type: 'string', enum: ['personal'] } })
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
      description: 'a routine without its #:schema line',
      overrides: {
        'routines/triage.toml': SEED_CONFIG_FILES['routines/triage.toml'].replace(
          '#:schema ../.pie/schema/routine.json\n',
          '',
        ),
      },
      errorClass: SchemaLineMissing,
      filePath: 'routines/triage.toml',
    },
    {
      description: 'a recipe added without a sync',
      overrides: { 'recipes/work.toml': SEED_CONFIG_FILES['recipes/personal.toml'] },
      errorClass: SchemaFileStale,
      filePath: '.pie/schema/routine.json',
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
