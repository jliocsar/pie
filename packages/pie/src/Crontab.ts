import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type { Routine } from './ConfigRepo.ts'
import { homeDirectory, shellBlockMarkersOf, withBlock, withoutBlock } from './Pod.ts'

const NO_CRONTAB_PATTERN = /^no crontab for /u
const DEFAULT_CRONTAB_COMMAND = 'crontab'
const ROUTINES_BLOCK_MARKERS = shellBlockMarkersOf('routines')

export const INSTALLED_PIE_PATH = '/usr/local/bin/pie'

export class CrontabCommandFailed extends Schema.TaggedError<CrontabCommandFailed>()(
  'CrontabCommandFailed',
  {
    crontabArguments: Schema.Array(Schema.String),
    exitCode: Schema.Int,
    crontabOutput: Schema.String,
  },
) {
  override get message(): string {
    return `crontab ${this.crontabArguments.join(' ')} exited with ${this.exitCode}: ${this.crontabOutput.trim()}. Routines run from cron, so the VM needs it installed and running.`
  }
}

const crontabCommand = Config.String('PIE_CRONTAB').pipe(
  Config.withDefault(DEFAULT_CRONTAB_COMMAND),
)

const runCrontab = Effect.fn('runCrontab')(function* (
  crontabArguments: readonly string[],
  stdin: ChildProcess.CommandInput,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const crontabProcess = yield* spawner.spawn(
    ChildProcess.make(yield* crontabCommand, crontabArguments, {
      extendEnv: true,
      env: { HOME: yield* homeDirectory },
      stdin,
    }),
  )
  const [standardOutput, standardError, exitCode] = yield* Effect.all(
    [
      Stream.mkString(Stream.decodeText(crontabProcess.stdout)),
      Stream.mkString(Stream.decodeText(crontabProcess.stderr)),
      crontabProcess.exitCode,
    ],
    { concurrency: 'unbounded' },
  )

  return { standardOutput, standardError, exitCode }
}, Effect.scoped)

const readCrontab = Effect.gen(function* () {
  const { standardOutput, standardError, exitCode } = yield* runCrontab(['-l'], 'ignore')

  if (exitCode === 0) {
    return standardOutput
  }

  if (NO_CRONTAB_PATTERN.test(standardError)) {
    return ''
  }

  return yield* new CrontabCommandFailed({
    crontabArguments: ['-l'],
    exitCode,
    crontabOutput: standardError,
  })
})

const writeCrontab = (crontab: string) =>
  runCrontab(['-'], Stream.make(new TextEncoder().encode(crontab))).pipe(
    Effect.filterOrFail(
      ({ exitCode }) => exitCode === 0,
      ({ exitCode, standardError }) =>
        new CrontabCommandFailed({
          crontabArguments: ['-'],
          exitCode,
          crontabOutput: standardError,
        }),
    ),
  )

const routineScheduleOf = (routines: Record.ReadonlyRecord<string, Routine>) =>
  Record.toEntries(routines)
    .map(
      ([routineName, routine]) =>
        `${routine.schedule} ${INSTALLED_PIE_PATH} routine run ${routineName}`,
    )
    .join('\n')

export const writeRoutineSchedule = Effect.fn('writeRoutineSchedule')(function* (
  routines: Record.ReadonlyRecord<string, Routine>,
) {
  const crontab = yield* readCrontab
  const updatedCrontab = Record.isEmptyRecord(routines)
    ? withoutBlock(crontab, ROUTINES_BLOCK_MARKERS)
    : withBlock(crontab, ROUTINES_BLOCK_MARKERS, routineScheduleOf(routines))

  if (updatedCrontab !== crontab) {
    yield* writeCrontab(updatedCrontab)
  }
})
