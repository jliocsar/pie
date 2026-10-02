import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Path from 'effect/Path'

export const REGULAR_FILE_MODE = 0o644

export const EXECUTABLE_FILE_MODE = 0o755

export const PRIVATE_DIRECTORY_MODE = 0o700

const PERMISSION_BITS = 0o777

const EXECUTABLE_MODE_BITS = 0o111

export const homeDirectory = Config.String('HOME')

export const configHome = Config.String('XDG_CONFIG_HOME').pipe(
  Config.orElse(() => homeDirectory.pipe(Config.map((home) => `${home}/.config`))),
)

export const cacheHome = Config.String('XDG_CACHE_HOME').pipe(
  Config.orElse(() => homeDirectory.pipe(Config.map((home) => `${home}/.cache`))),
)

export const readPodFile = Effect.fn('readPodFile')(function* (
  configDirectory: string,
  filePath: string,
  podPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absoluteFilePath = path.join(configDirectory, filePath)
  const content = yield* fileSystem.readFile(absoluteFilePath)
  const fileInfo = yield* fileSystem.stat(absoluteFilePath)

  return { path: podPath, content, executable: (fileInfo.mode & EXECUTABLE_MODE_BITS) !== 0 }
})

export type PodFile = Effect.Success<ReturnType<typeof readPodFile>>

export const writeFileIfChanged = Effect.fn('writeFileIfChanged')(function* (
  filePath: string,
  content: Uint8Array,
  fileMode: number,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const unchanged =
    (yield* fileSystem.exists(filePath)) &&
    Buffer.compare(yield* fileSystem.readFile(filePath), content) === 0

  if (!unchanged) {
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true })
    yield* fileSystem.writeFile(filePath, content, { mode: fileMode })
  }

  const currentMode = (yield* fileSystem.stat(filePath)).mode & PERMISSION_BITS

  if (currentMode !== fileMode) {
    yield* fileSystem.chmod(filePath, fileMode)
  }
})
