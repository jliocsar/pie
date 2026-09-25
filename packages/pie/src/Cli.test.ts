import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Command from 'effect/unstable/cli/Command'
import { CommandNotBuiltYet, pie } from './Cli.ts'

const bunServicesRuntime = ManagedRuntime.make(BunServices.layer)

const runPie = (commandLine: readonly string[]) =>
  Command.runWith(pie, { version: '0.0.0-test' })(commandLine)

afterAll(() => bunServicesRuntime.dispose())

describe('pie', () => {
  test('--version succeeds', () => bunServicesRuntime.runPromise(runPie(['--version'])))

  test.each([
    { commandLine: ['serve'] },
    { commandLine: ['login', 'some-invite'] },
    { commandLine: ['invite', 'new'] },
    { commandLine: ['pods', 'ls'] },
    { commandLine: ['pod', 'up'] },
  ])('$commandLine fails as not built yet', ({ commandLine }) =>
    bunServicesRuntime.runPromise(
      Effect.gen(function* () {
        const error = yield* Effect.flip(runPie(commandLine))

        expect(error).toBeInstanceOf(CommandNotBuiltYet)
      }),
    ),
  )
})
