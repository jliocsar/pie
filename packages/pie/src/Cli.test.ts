import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as ConfigProvider from 'effect/ConfigProvider'
import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Path from 'effect/Path'
import * as Command from 'effect/unstable/cli/Command'
import * as FetchHttpClient from 'effect/unstable/http/FetchHttpClient'
import { NotAnAdmin } from './Api.ts'
import { CommandNotBuiltYet, InviteUnreadable, NotJoined, pie } from './Cli.ts'
import { inFreshDirectory, SERVER_URL, startPie } from './test/TestPie.ts'

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

afterAll(() => bunServicesRuntime.dispose())

describe('pie', () => {
  test('--version succeeds', () => bunServicesRuntime.runPromise(runPie(['--version'])))

  test('pod up fails as not built yet', () =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(runPie(['pod', 'up']))

        expect(error).toBeInstanceOf(CommandNotBuiltYet)
      }),
    ))

  test('bootstrap, join as master, invite a pod, join as the pod, and list it', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { requestPie, fetchPie, dataDirectory } = yield* startPie(temporaryDirectory)
          const output = capturingConsole()
          const fetchThroughPie = Object.assign(fetchPie, {
            preconnect: globalThis.fetch.preconnect,
          })
          const runPieOn = (machineName: string, commandLine: readonly string[]) =>
            runPie(commandLine).pipe(
              Effect.provideService(FetchHttpClient.Fetch, fetchThroughPie),
              Effect.provideService(Console.Console, output.console),
              Effect.provideService(
                ConfigProvider.ConfigProvider,
                ConfigProvider.fromEnv({
                  env: { XDG_CONFIG_HOME: path.join(temporaryDirectory, machineName) },
                }),
              ),
            )

          yield* requestPie('/whoami', {})
          yield* runPieOn('server', ['bootstrap', '--data-dir', dataDirectory])

          const masterSetupLine = output.stdout.at(-1)

          yield* runPieOn('laptop', ['join', lastWordOf(masterSetupLine)])
          yield* runPieOn('laptop', ['invite', 'new', '--name', 'sprite', '--recipe', 'personal'])

          const podSetupLine = output.stdout.at(-1)

          yield* runPieOn('sprite', ['join', lastWordOf(podSetupLine)])
          yield* runPieOn('laptop', ['pods', 'ls'])

          const podTable = output.stdout.at(-1)
          const tokenMode = yield* fileSystem
            .stat(path.join(temporaryDirectory, 'laptop', 'pie', 'token'))
            .pipe(Effect.map((info) => info.mode & 0o777))
          const savedServerUrl = yield* fileSystem.readFileString(
            path.join(temporaryDirectory, 'laptop', 'pie', 'url'),
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
