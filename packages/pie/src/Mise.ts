import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import type { ResolvedEnvironment, ToolRequest } from './ConfigRepo.ts'
import {
  configHome,
  EXECUTABLE_FILE_MODE,
  homeDirectory,
  type PodFile,
  REGULAR_FILE_MODE,
  shellBlockMarkersOf,
  updateTextFile,
  withBlock,
  writeFileIfChanged,
} from './Pod.ts'

const MISE_INSTALLER_URL = 'https://mise.run'
const MISE_SHIMS_PATH_LINE = 'export PATH="$HOME/.local/share/mise/shims:$PATH"'
const MISE_ZSH_ACTIVATE_LINE = 'eval "$($HOME/.local/bin/mise activate zsh)"'

export class CommandFailed extends Schema.TaggedError<CommandFailed>()('CommandFailed', {
  commandLine: Schema.Array(Schema.String),
  exitCode: Schema.Int,
}) {
  override get message(): string {
    return `\`${this.commandLine.join(' ')}\` exited with ${this.exitCode}.`
  }
}

const misePath = Effect.gen(function* () {
  const path = yield* Path.Path

  return path.join(yield* homeDirectory, '.local', 'bin', 'mise')
})

const runCommand = Effect.fn('runCommand')(function* (commandLine: readonly [string, ...string[]]) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
  const home = yield* homeDirectory
  const [command, ...commandArguments] = commandLine
  yield* spawner
    .exitCode(
      ChildProcess.make(command, commandArguments, {
        cwd: home,
        extendEnv: true,
        env: { HOME: home },
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      }),
    )
    .pipe(
      Effect.filterOrFail(
        (exitCode) => exitCode === 0,
        (exitCode) => new CommandFailed({ commandLine, exitCode }),
      ),
    )
})

export const runMise = Effect.fn('runMise')(function* (miseArguments: readonly string[]) {
  yield* runCommand([yield* misePath, ...miseArguments])
})

const tomlInlineTableOf = (toolRequest: ToolRequest) =>
  `{ ${Arr.map(
    Record.toEntries(toolRequest),
    ([optionName, optionValue]) => `${JSON.stringify(optionName)} = ${JSON.stringify(optionValue)}`,
  ).join(', ')} }`

const tomlTableOf = (tableName: string, tomlValues: Record.ReadonlyRecord<string, string>) => [
  `[${tableName}]`,
  ...Arr.map(
    Record.toEntries(tomlValues),
    ([key, tomlValue]) => `${JSON.stringify(key)} = ${tomlValue}`,
  ),
]

const miseConfigOf = (environment: ResolvedEnvironment) =>
  [
    ...tomlTableOf('tools', Record.map(environment.tools, tomlInlineTableOf)),
    ...tomlTableOf(
      'env',
      Record.map(environment.env, (envValue) => JSON.stringify(envValue)),
    ),
    '',
  ].join('\n')

const installMiseWhenMissing = Effect.fn('installMiseWhenMissing')(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  if (yield* fileSystem.exists(yield* misePath)) {
    return
  }

  const installerPath = path.join(yield* fileSystem.makeTempDirectoryScoped(), 'install-mise.sh')

  yield* runCommand(['curl', '-fsSL', MISE_INSTALLER_URL, '-o', installerPath])
  yield* runCommand(['sh', installerPath])
}, Effect.scoped)

export const installTools = Effect.fn('installTools')(function* (environment: ResolvedEnvironment) {
  const path = yield* Path.Path
  const home = yield* homeDirectory

  yield* installMiseWhenMissing()
  yield* writeFileIfChanged(
    path.join(yield* configHome, 'mise', 'conf.d', 'pie.toml'),
    new TextEncoder().encode(miseConfigOf(environment)),
    REGULAR_FILE_MODE,
  )
  yield* runMise(['install'])
  yield* updateTextFile(path.join(home, '.profile'), (text) =>
    withBlock(text, shellBlockMarkersOf('mise'), MISE_SHIMS_PATH_LINE),
  )
  yield* updateTextFile(path.join(home, '.zshrc'), (text) =>
    withBlock(text, shellBlockMarkersOf('mise'), MISE_ZSH_ACTIVATE_LINE),
  )
})

export const runTasks = Effect.fn('runTasks')(function* (tasks: readonly PodFile[]) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const taskDirectory = yield* fileSystem.makeTempDirectoryScoped()

  yield* Effect.forEach(
    tasks,
    (task) => {
      const taskPath = path.join(taskDirectory, task.path)

      return writeFileIfChanged(taskPath, task.content, EXECUTABLE_FILE_MODE).pipe(
        Effect.andThen(runMise(['exec', '--', taskPath])),
      )
    },
    { discard: true },
  )
}, Effect.scoped)
