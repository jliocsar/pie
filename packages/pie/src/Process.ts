import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import type * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Stream from 'effect/Stream'
import * as Str from 'effect/String'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'

type CommandLine = readonly [command: string, ...commandArguments: string[]]

type Environment = Record.ReadonlyRecord<string, string>

interface InheritedRun {
  readonly workingDirectory: string
  readonly environment: Environment
}

export class CommandFailed extends Schema.TaggedError<CommandFailed>()('CommandFailed', {
  commandLine: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  commandOutput: Schema.String,
}) {
  override get message(): string {
    const failure = `\`${this.commandLine.join(' ')}\` exited with ${this.exitCode}`

    return Option.match(Option.liftPredicate(Str.trim(this.commandOutput), Str.isNonEmpty), {
      onNone: () => `${failure}.`,
      onSome: (commandOutput) => `${failure}: ${commandOutput}`,
    })
  }
}

export class Process extends Context.Service<Process>()('pie/Process', {
  make: Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    const capture = Effect.fn('Process.capture')(function* (
      commandLine: CommandLine,
      environment: Environment,
    ) {
      const [command, ...commandArguments] = commandLine
      const childProcess = yield* spawner.spawn(
        ChildProcess.make(command, commandArguments, {
          extendEnv: true,
          env: environment,
          stdin: 'ignore',
        }),
      )
      const [commandOutput, exitCode] = yield* Effect.all(
        [Stream.mkString(Stream.decodeText(childProcess.all)), childProcess.exitCode],
        { concurrency: 'unbounded' },
      )

      if (exitCode === 0) {
        return commandOutput
      }

      return yield* new CommandFailed({ commandLine, exitCode, commandOutput })
    }, Effect.scoped)

    const inherit = Effect.fn('Process.inherit')(function* (
      commandLine: CommandLine,
      { workingDirectory, environment }: InheritedRun,
    ) {
      const [command, ...commandArguments] = commandLine
      yield* spawner
        .exitCode(
          ChildProcess.make(command, commandArguments, {
            cwd: workingDirectory,
            extendEnv: true,
            env: environment,
            stdin: 'ignore',
            stdout: 'inherit',
            stderr: 'inherit',
          }),
        )
        .pipe(
          Effect.filterOrFail(
            (exitCode) => exitCode === 0,
            (exitCode) => new CommandFailed({ commandLine, exitCode, commandOutput: '' }),
          ),
        )
    })

    return { capture, inherit }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
