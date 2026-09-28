import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Arr from 'effect/Array'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { NotAnAdmin } from './Api.ts'
import { InviteUnreadable, NotJoined, pie } from './Cli.ts'
import { ClaudeEntryNotPies, McpServerNotPies } from './Pod.ts'
import { runGit } from './Server.ts'
import {
  commitToConfigSource,
  inFreshDirectory,
  SEED_CONFIG_FILES,
  SERVER_URL,
  startPie,
} from './test/TestPie.ts'

const FAKE_MISE_SCRIPT = `#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/mise-calls"
`

const EXECUTABLE_FILE_MODE = 0o755

const PERMISSION_BITS = 0o777

const CHECKED_OUT_REPOSITORY_DIRECTORIES = ['jliocsar/pie', 'nidus']

const TASK_PATH_PATTERN = /^exec -- \/\S*\/(?<taskName>[^/\s]+)$/u

const TOOL_AND_TASK_CALLS = ['install', 'exec -- <tasks>/workspace']

const MCP_ADD_CALLS = [
  'exec -- claude mcp add-json --scope user fff {"type":"stdio","command":"fff-mcp","args":[]}',
  'exec -- claude mcp add-json --scope user docs {"type":"http","url":"https://docs.example/mcp"}',
]

const bunServicesRuntime = ManagedRuntime.make(BunServices.layer)

const runPie = (commandLine: readonly string[]) =>
  Command.runWith(pie, { version: '0.0.0-test' })(commandLine).pipe(
    Effect.provide(FetchHttpClient.layer),
  )

const capturingConsole = () => {
  const stdout: string[] = []
  const stderr: string[] = []
  const console: Console.Console = {
    ...globalThis.console,
    log: (...parts: readonly string[]) => {
      stdout.push(parts.join(' '))
    },
    error: (...parts: readonly string[]) => {
      stderr.push(parts.join(' '))
    },
  }

  return { stdout, stderr, console }
}

const lastWordOf = (line: string | undefined) => line?.split(' ').at(-1) ?? ''

const startPieWithAdmin = Effect.fn('startPieWithAdmin')(function* (temporaryDirectory: string) {
  const path = yield* Path.Path
  const startedPie = yield* startPie(temporaryDirectory)
  const output = capturingConsole()
  const fetchThroughPie = Object.assign(startedPie.fetchPie, {
    preconnect: globalThis.fetch.preconnect,
  })
  const homeOf = (machineName: string) => path.join(temporaryDirectory, machineName)
  const runPieOn = (machineName: string, commandLine: readonly string[]) =>
    runPie(commandLine).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetchThroughPie),
      Effect.provideService(Console.Console, output.console),
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({ env: { HOME: homeOf(machineName) } }),
      ),
    )
  const joinPod = (machineName: string, inviteArguments: readonly string[]) =>
    runPieOn('laptop', ['invite', 'new', '--name', machineName, ...inviteArguments]).pipe(
      Effect.andThen(
        Effect.suspend(() => runPieOn(machineName, ['join', lastWordOf(output.stdout.at(-1))])),
      ),
    )

  yield* startedPie.requestPie('/whoami', {})
  yield* runPieOn('server', ['bootstrap', '--data-dir', startedPie.dataDirectory])
  yield* runPieOn('laptop', ['join', lastWordOf(output.stdout.at(-1))])

  return { ...startedPie, output, homeOf, runPieOn, joinPod }
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
    return Arr.map(
      Arr.filter((yield* fileSystem.readFileString(miseCallsPath)).split('\n'), Boolean),
      (miseCall) => miseCall.replace(TASK_PATH_PATTERN, 'exec -- <tasks>/$<taskName>'),
    )
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

afterAll(() => bunServicesRuntime.dispose())

describe('pie', () => {
  test('--version succeeds', () => bunServicesRuntime.runPromise(runPie(['--version'])))

  test('bootstrap, join as master, invite a pod, join as the pod, and list it', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { output, homeOf, runPieOn, joinPod } = yield* startPieWithAdmin(temporaryDirectory)
          const masterSetupLine = output.stdout.at(-2)

          yield* joinPod('sprite', ['--recipe', 'personal'])

          const podSetupLine = output.stdout.at(-2)

          yield* runPieOn('laptop', ['pods', 'ls'])

          const podTable = output.stdout.at(-1)
          const tokenMode = yield* fileSystem
            .stat(path.join(homeOf('laptop'), '.config', 'pie', 'token'))
            .pipe(Effect.map((info) => info.mode & PERMISSION_BITS))
          const savedServerUrl = yield* fileSystem.readFileString(
            path.join(homeOf('laptop'), '.config', 'pie', 'url'),
          )
          const podListingPods = yield* Effect.flip(runPieOn('sprite', ['pods', 'ls']))
          const strangerListingPods = yield* Effect.flip(runPieOn('stranger', ['pods', 'ls']))
          const garbageJoin = yield* Effect.flip(runPieOn('stranger', ['join', 'not-an-invite']))

          expect(masterSetupLine).toStartWith('pie join ')
          expect(podSetupLine).toStartWith(
            'curl -fsSL https://github.com/jliocsar/pie/releases/latest/download/setup.sh | sh -s -- ',
          )
          expect(output.stdout).toContain(`Joined pie at ${SERVER_URL} as master (admin).`)
          expect(output.stdout).toContain(`Joined pie at ${SERVER_URL} as sprite (pod).`)
          expect(podTable).toBe(
            [
              'NAME    RECIPE    COMMIT  INVITED BY  LAST SEEN',
              'sprite  personal  -       master      just now',
            ].join('\n'),
          )
          expect(tokenMode).toBe(0o600)
          expect(savedServerUrl).toBe(`${SERVER_URL}\n`)
          expect(podListingPods).toBeInstanceOf(NotAnAdmin)
          expect(strangerListingPods).toBeInstanceOf(NotJoined)
          expect(garbageJoin).toBeInstanceOf(InviteUnreadable)
        }),
      ),
    ))
})

describe('pie pod up', () => {
  test('installs the tools, runs the tasks, writes ~/.claude, adds MCPs through claude, and a rerun changes nothing', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { output, homeOf, runPieOn, joinPod, sourceDirectory } =
            yield* startPieWithAdmin(temporaryDirectory)
          const home = homeOf('sprite')
          const claudeDirectory = path.join(home, '.claude')
          const manifestPath = path.join(home, '.config', 'pie', 'manifest.json')
          const headCommit = yield* runGit(['-C', sourceDirectory, 'rev-parse', 'HEAD'])
          const abbreviatedCommit = headCommit.slice(0, 7)

          yield* joinPod('sprite', ['--recipe', 'personal'])
          yield* prepareBox(home)
          yield* runPieOn('sprite', ['pod', 'up'])
          yield* writeClaudeState(home, ['fff', 'docs'])

          const firstMiseCalls = yield* readMiseCalls(home)
          const firstSnapshot = yield* snapshotDirectory(claudeDirectory)
          const firstManifestModifiedAt = (yield* fileSystem.stat(manifestPath)).mtime

          yield* runPieOn('sprite', ['pod', 'up'])

          const secondMiseCalls = yield* readMiseCalls(home)
          const secondSnapshot = yield* snapshotDirectory(claudeDirectory)
          const manifestModifiedAt = (yield* fileSystem.stat(manifestPath)).mtime
          const miseConfig = yield* fileSystem.readFileString(
            path.join(home, '.config', 'mise', 'conf.d', 'pie.toml'),
          )
          const shellStartupFiles = yield* Effect.forEach(['.profile', '.zshrc'], (fileName) =>
            fileSystem.readFileString(path.join(home, fileName)),
          )

          yield* runPieOn('laptop', ['pods', 'ls'])

          expect(firstMiseCalls).toEqual([...TOOL_AND_TASK_CALLS, ...MCP_ADD_CALLS])
          expect(Record.map(firstSnapshot, ({ text, mode }) => ({ text, mode }))).toEqual({
            'agents/oracle.md': { text: SEED_CONFIG_FILES['agents/oracle.md'], mode: 0o644 },
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
          expect(miseConfig).toBe(
            '[tools]\n"node" = { "version" = "24.19.0" }\n"github:dmtrKovalenko/fff" = { "version" = "0.10.6", "matching" = "fff-mcp", "bin" = "fff-mcp" }\n',
          )
          expect(shellStartupFiles).toEqual(
            Arr.replicate('\nexport PATH="$HOME/.local/share/mise/shims:$PATH"\n', 2),
          )
          expect(secondSnapshot).toEqual(firstSnapshot)
          expect(manifestModifiedAt).toEqual(firstManifestModifiedAt)
          expect(output.stdout).toContain(`Applied config commit ${abbreviatedCommit}.`)
          expect(output.stdout.at(-1)).toContain(`sprite  personal  ${abbreviatedCommit}`)
        }),
      ),
    ))

  test("removes what a changed recipe dropped, and leaves what pie didn't write", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn, joinPod, sourceDirectory } =
            yield* startPieWithAdmin(temporaryDirectory)
          const home = homeOf('sprite')
          const claudeDirectory = path.join(home, '.claude')
          const ownSkillPath = path.join(claudeDirectory, 'skills', 'mine', 'SKILL.md')

          yield* joinPod('sprite', ['--recipe', 'personal'])
          yield* prepareBox(home)
          yield* runPieOn('sprite', ['pod', 'up'])
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
          yield* runPieOn('sprite', ['pod', 'up'])

          const remainingClaudeFiles = yield* snapshotDirectory(claudeDirectory)
          const handoffStillThere = yield* fileSystem.exists(
            path.join(claudeDirectory, 'skills', 'handoff'),
          )
          const miseCalls = yield* readMiseCalls(home)

          expect(Record.keys(remainingClaudeFiles)).toEqual(['skills/mine/SKILL.md'])
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

  test("fails before changing anything when a skill or an MCP of the same name isn't pie's", () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { homeOf, runPieOn, joinPod } = yield* startPieWithAdmin(temporaryDirectory)
          const skillHome = homeOf('skill-box')
          const mcpHome = homeOf('mcp-box')
          const ownSkillPath = path.join(skillHome, '.claude', 'skills', 'handoff', 'SKILL.md')

          yield* joinPod('skill-box', ['--recipe', 'personal'])
          yield* joinPod('mcp-box', ['--recipe', 'personal'])
          yield* Effect.forEach([skillHome, mcpHome], prepareBox, { discard: true })
          yield* fileSystem.makeDirectory(path.dirname(ownSkillPath), { recursive: true })
          yield* fileSystem.writeFileString(ownSkillPath, 'mine')
          yield* writeClaudeState(mcpHome, ['fff'])

          const skillClash = yield* Effect.flip(runPieOn('skill-box', ['pod', 'up']))
          const mcpClash = yield* Effect.flip(runPieOn('mcp-box', ['pod', 'up']))
          const skillBoxAgentsWritten = yield* fileSystem.exists(
            path.join(skillHome, '.claude', 'agents'),
          )
          const mcpBoxClaudeWritten = yield* fileSystem.exists(path.join(mcpHome, '.claude'))
          const miseCalls = [
            ...(yield* readMiseCalls(skillHome)),
            ...(yield* readMiseCalls(mcpHome)),
          ]

          expect(skillClash).toEqual(
            new ClaudeEntryNotPies({ entryPath: path.dirname(ownSkillPath) }),
          )
          expect(mcpClash).toEqual(new McpServerNotPies({ mcpName: 'fff' }))
          expect([skillBoxAgentsWritten, mcpBoxClaudeWritten]).toEqual([false, false])
          expect(miseCalls).toEqual([])
        }),
      ),
    ))

  test('a pod with no recipe gets told so, and succeeds', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { output, runPieOn, joinPod } = yield* startPieWithAdmin(temporaryDirectory)

          yield* joinPod('bare', [])
          yield* runPieOn('bare', ['pod', 'up'])

          expect(output.stderr.at(-1)).toBe("bare has no recipe yet, so there's nothing to apply.")
        }),
      ),
    ))
})
