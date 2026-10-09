import * as Console from 'effect/Console'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import { loadConfig, type Routine } from '../ConfigRepo.ts'
import { configCheckoutDirectoryOf, configRepositoryOf } from '../Git.ts'
import { misePath } from '../Mise.ts'
import { homeDirectory, PodFileUnreadable, PRIVATE_DIRECTORY_MODE, stateHome } from '../Pod.ts'
import { RoutineNotFound } from './Pod.ts'

const PROCESS_DIRECTORY = '/proc'

export const BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id'

const RunOutcome = Schema.Literals(['succeeded', 'failed', 'timed-out', 'interrupted'])

type RunOutcome = typeof RunOutcome.Type

const RunEvent = Schema.Union([
  Schema.Struct({
    run: Schema.String,
    event: Schema.Literal('started'),
    at: Schema.DateTimeUtcFromString,
    sessionId: Schema.String,
  }),
  Schema.Struct({
    run: Schema.String,
    event: Schema.Literal('finished'),
    at: Schema.DateTimeUtcFromString,
    outcome: RunOutcome,
  }),
  Schema.Struct({
    run: Schema.String,
    event: Schema.Literal('skipped'),
    at: Schema.DateTimeUtcFromString,
  }),
])

type RunEvent = typeof RunEvent.Type

const RunEventJson = Schema.fromJsonString(RunEvent)

const RunLock = Schema.Struct({ pid: Schema.Int, runId: Schema.String, bootId: Schema.String })

type RunLock = typeof RunLock.Type

export const RunLockJson = Schema.fromJsonString(RunLock)

export class RoutineRunUnsuccessful extends Schema.TaggedError<RoutineRunUnsuccessful>()(
  'RoutineRunUnsuccessful',
  { routineName: Schema.String, outcome: RunOutcome, sessionId: Schema.String },
) {
  override get message(): string {
    return `Routine ${this.routineName} ended ${this.outcome}. Open its session on this VM with \`claude --resume ${this.sessionId}\`.`
  }
}

const routineFilesOf = Effect.fn('routineFilesOf')(function* (routineName: string) {
  const path = yield* Path.Path
  const routineStateDirectory = path.join(yield* stateHome, 'pie', 'routines')

  return {
    routineStateDirectory,
    runLogPath: path.join(routineStateDirectory, `${routineName}.jsonl`),
    runLockPath: path.join(routineStateDirectory, `${routineName}.lock`),
  }
})

type RoutineFiles = Effect.Success<ReturnType<typeof routineFilesOf>>

const routineFromCheckout = Effect.fn('routineFromCheckout')(function* (routineName: string) {
  const repositoryName = yield* configRepositoryOf(Option.none())
  const config = yield* loadConfig(yield* configCheckoutDirectoryOf(repositoryName))

  return yield* Option.match(Record.get(config.routines, routineName), {
    onNone: () => Effect.fail(new RoutineNotFound({ routineName })),
    onSome: Effect.succeed,
  })
})

const appendRunEvent = Effect.fn('appendRunEvent')(function* (
  runLogPath: string,
  runEvent: RunEvent,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const runEventLine = yield* Schema.encodeEffect(RunEventJson)(runEvent)

  yield* fileSystem.writeFileString(runLogPath, `${runEventLine}\n`, { flag: 'a' })
})

const currentBootId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem

  return Str.trim(yield* fileSystem.readFileString(BOOT_ID_PATH))
})

const isRunAlive = Effect.fn('isRunAlive')(function* (runLock: RunLock) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return (
    runLock.bootId === (yield* currentBootId) &&
    (yield* fileSystem.exists(path.join(PROCESS_DIRECTORY, String(runLock.pid))))
  )
})

const createRunLock = Effect.fn('createRunLock')(function* (runLockPath: string, runLock: RunLock) {
  const fileSystem = yield* FileSystem.FileSystem
  const runLockText = yield* Schema.encodeEffect(RunLockJson)(runLock)

  return yield* fileSystem.writeFileString(runLockPath, runLockText, { flag: 'wx' }).pipe(
    Effect.as(true),
    Effect.catchReason('PlatformError', 'AlreadyExists', () => Effect.succeed(false)),
  )
})

const readRunLock = Effect.fn('readRunLock')(function* (runLockPath: string) {
  const fileSystem = yield* FileSystem.FileSystem

  return yield* fileSystem.readFileString(runLockPath).pipe(
    Effect.flatMap(Schema.decodeEffect(RunLockJson)),
    Effect.catchTag('SchemaError', (schemaError) =>
      Effect.fail(
        new PodFileUnreadable({ filePath: runLockPath, issueMessage: schemaError.message }),
      ),
    ),
  )
})

const takeRunLock = Effect.fn('takeRunLock')(function* (
  routineFiles: RoutineFiles,
  runLock: RunLock,
) {
  const fileSystem = yield* FileSystem.FileSystem

  if (yield* createRunLock(routineFiles.runLockPath, runLock)) {
    return true
  }

  const heldRunLock = yield* readRunLock(routineFiles.runLockPath)

  if (yield* isRunAlive(heldRunLock)) {
    return false
  }

  yield* appendRunEvent(routineFiles.runLogPath, {
    run: heldRunLock.runId,
    event: 'finished',
    at: yield* DateTime.now,
    outcome: 'interrupted',
  })
  yield* fileSystem.remove(routineFiles.runLockPath)

  return yield* createRunLock(routineFiles.runLockPath, runLock)
})

const runClaude = Effect.fn('runClaude')(function* (routine: Routine, sessionId: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = yield* homeDirectory
  const claudeArguments = [
    'exec',
    '--',
    'claude',
    '-p',
    routine.prompt,
    '--session-id',
    sessionId,
    ...routine.arguments,
  ]

  return yield* spawner
    .exitCode(
      ChildProcess.make(yield* misePath, claudeArguments, {
        cwd: home,
        extendEnv: true,
        env: { HOME: home },
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
        killSignal: 'SIGKILL',
      }),
    )
    .pipe(
      Effect.map((exitCode): RunOutcome => (exitCode === 0 ? 'succeeded' : 'failed')),
      Effect.timeoutOption(routine.timeout),
      Effect.map(Option.getOrElse((): RunOutcome => 'timed-out')),
      Effect.catchTag('PlatformError', (platformError) =>
        Console.error(platformError.message).pipe(Effect.as<RunOutcome>('failed')),
      ),
    )
})

const runWithLock = Effect.fn('runWithLock')(function* (
  routine: Routine,
  routineFiles: RoutineFiles,
  runId: string,
) {
  const crypto = yield* Crypto.Crypto
  const sessionId = yield* crypto.randomUUIDv4

  yield* appendRunEvent(routineFiles.runLogPath, {
    run: runId,
    event: 'started',
    at: yield* DateTime.now,
    sessionId,
  })

  const outcome = yield* runClaude(routine, sessionId).pipe(
    Effect.onInterrupt(() =>
      DateTime.now.pipe(
        Effect.flatMap((at) =>
          appendRunEvent(routineFiles.runLogPath, {
            run: runId,
            event: 'finished',
            at,
            outcome: 'interrupted',
          }),
        ),
        Effect.ignore,
      ),
    ),
  )

  yield* appendRunEvent(routineFiles.runLogPath, {
    run: runId,
    event: 'finished',
    at: yield* DateTime.now,
    outcome,
  })

  return { outcome, sessionId }
})

const runRoutine = Effect.fn('runRoutine')(function* (routineName: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const crypto = yield* Crypto.Crypto
  const routine = yield* routineFromCheckout(routineName)
  const routineFiles = yield* routineFilesOf(routineName)
  const runId = yield* crypto.randomUUIDv7

  yield* fileSystem.makeDirectory(routineFiles.routineStateDirectory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })

  const lockTaken = yield* takeRunLock(routineFiles, {
    pid: process.pid,
    runId,
    bootId: yield* currentBootId,
  })

  if (!lockTaken) {
    yield* appendRunEvent(routineFiles.runLogPath, {
      run: runId,
      event: 'skipped',
      at: yield* DateTime.now,
    })

    return yield* Console.log(`Skipped routine ${routineName}: its previous run is still going.`)
  }

  const { outcome, sessionId } = yield* runWithLock(routine, routineFiles, runId).pipe(
    Effect.ensuring(Effect.ignore(fileSystem.remove(routineFiles.runLockPath, { force: true }))),
  )

  if (outcome !== 'succeeded') {
    return yield* new RoutineRunUnsuccessful({ routineName, outcome, sessionId })
  }

  return yield* Console.log(`Routine ${routineName} succeeded in session ${sessionId}.`)
})

export const routine = Command.make('routine').pipe(
  Command.withDescription('Commands for routines, the scheduled claude runs on a routine VM.'),
  Command.withSubcommands([
    Command.make(
      'run',
      { routineName: Argument.String('name') },
      Effect.fn(function* ({ routineName }) {
        yield* runRoutine(routineName)
      }),
    ).pipe(
      Command.withDescription(
        'Run a routine once, from the config pod up last applied. cron calls this; a run while the last one is still going is logged as skipped.',
      ),
    ),
  ]),
)
