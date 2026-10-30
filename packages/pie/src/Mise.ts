import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import type { ResolvedEnvironment, TaskFile, ToolRequest } from './ConfigRepo.ts'
import {
  BOX_LAYOUT,
  Box,
  EXECUTABLE_FILE_MODE,
  REGULAR_FILE_MODE,
  shellBlockMarkersOf,
  shellPathOf,
  withBlock,
} from './Pod.ts'
import { Process } from './Process.ts'

const MISE_INSTALLER_URL = 'https://mise.run'
const MISE_TOOL_AUTO_UPDATE_LINE = 'tool_update.global_auto = true'
const MISE_SHIMS_PATH_LINE = `export PATH="${shellPathOf(BOX_LAYOUT.miseDataDirectory)}/shims:$PATH"`
const MISE_ZSH_ACTIVATE_LINE = `eval "$(${shellPathOf(BOX_LAYOUT.miseBinary)} activate zsh)"`

const runCommand = Effect.fn('runCommand')(function* (commandLine: readonly [string, ...string[]]) {
  const processes = yield* Process
  const { home } = yield* Box

  yield* processes.inherit(commandLine, { workingDirectory: home, environment: { HOME: home } })
})

export const runMise = Effect.fn('runMise')(function* (miseArguments: readonly string[]) {
  const box = yield* Box

  yield* runCommand([box.paths.miseBinary, ...miseArguments])
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
    '[settings]',
    MISE_TOOL_AUTO_UPDATE_LINE,
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
  const box = yield* Box

  if (yield* fileSystem.exists(box.paths.miseBinary)) {
    return
  }

  const installerPath = path.join(yield* fileSystem.makeTempDirectoryScoped(), 'install-mise.sh')

  yield* runCommand(['curl', '-fsSL', MISE_INSTALLER_URL, '-o', installerPath])
  yield* runCommand(['sh', installerPath])
}, Effect.scoped)

export const installTools = Effect.fn('installTools')(function* (environment: ResolvedEnvironment) {
  const path = yield* Path.Path
  const box = yield* Box

  yield* installMiseWhenMissing()
  yield* box.writeFileIfChanged(
    path.join(box.paths.miseConfigDirectory, 'conf.d', 'pie.toml'),
    miseConfigOf(environment),
    REGULAR_FILE_MODE,
  )
  yield* runMise(['install'])
  yield* box.updateTextFile(box.paths.profile, (text) =>
    withBlock(text, shellBlockMarkersOf('mise'), MISE_SHIMS_PATH_LINE),
  )
  yield* box.updateTextFile(box.paths.zshrc, (text) =>
    withBlock(text, shellBlockMarkersOf('mise'), MISE_ZSH_ACTIVATE_LINE),
  )
})

export const runTasks = Effect.fn('runTasks')(function* (tasks: readonly TaskFile[]) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const box = yield* Box
  const taskDirectory = yield* fileSystem.makeTempDirectoryScoped()

  yield* Effect.forEach(
    tasks,
    (task) => {
      const taskPath = path.join(taskDirectory, task.taskName)

      return box
        .writeFileIfChanged(taskPath, task.content, EXECUTABLE_FILE_MODE)
        .pipe(Effect.andThen(runMise(['exec', '--', taskPath])))
    },
    { discard: true },
  )
}, Effect.scoped)
