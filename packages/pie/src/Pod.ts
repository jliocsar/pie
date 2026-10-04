import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import type { ResolvedRecipe } from './ConfigRepo.ts'

type BlockMarkers = readonly [startMarker: string, endMarker: string]

const PERMISSION_BITS = 0o777
const EXECUTABLE_MODE_BITS = 0o111

export const REGULAR_FILE_MODE = 0o644
export const EXECUTABLE_FILE_MODE = 0o755
export const PRIVATE_DIRECTORY_MODE = 0o700

export const MARKDOWN_BLOCK_MARKERS: BlockMarkers = [
  '<!-- >>> pie >>> -->\n',
  '<!-- <<< pie <<< -->\n',
]

const AppendedBlock = Schema.Struct({ homePath: Schema.String, homeName: Schema.String })

const HomeManifest = Schema.Struct({
  copiedFiles: Schema.Array(Schema.String),
  appendedBlocks: Schema.Array(AppendedBlock),
})

type HomeManifest = typeof HomeManifest.Type

const HomeManifestJson = Schema.fromJsonString(HomeManifest)

const EMPTY_HOME_MANIFEST: HomeManifest = { copiedFiles: [], appendedBlocks: [] }

const isSameAppendedBlock = Schema.toEquivalence(AppendedBlock)

export class PodFileUnreadable extends Schema.TaggedError<PodFileUnreadable>()(
  'PodFileUnreadable',
  { filePath: Schema.String, issueMessage: Schema.String },
) {
  override get message(): string {
    return `${this.filePath} isn't the JSON pie expected: ${this.issueMessage}`
  }
}

export class HomeFileNotPies extends Schema.TaggedError<HomeFileNotPies>()('HomeFileNotPies', {
  filePath: Schema.String,
  homeName: Schema.String,
}) {
  override get message(): string {
    return `${this.filePath} already exists, and pie didn't write it. Move it out of the way, or append to it with { name = "${this.homeName}", mode = "append" }. Then run \`pie pod up\` again.`
  }
}

export const homeDirectory = Config.String('HOME')

export const configHome = Config.String('XDG_CONFIG_HOME').pipe(
  Config.orElse(() => homeDirectory.pipe(Config.map((home) => `${home}/.config`))),
)

export const cacheHome = Config.String('XDG_CACHE_HOME').pipe(
  Config.orElse(() => homeDirectory.pipe(Config.map((home) => `${home}/.cache`))),
)

const homeManifestPath = Effect.gen(function* () {
  const path = yield* Path.Path

  return path.join(yield* configHome, 'pie', 'home-manifest.json')
})

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

export const decodeJsonFile = <Decoded>(schema: Schema.Codec<Decoded, string>) =>
  Effect.fn('decodeJsonFile')(function* (filePath: string, fallback: Decoded) {
    const fileSystem = yield* FileSystem.FileSystem

    if (!(yield* fileSystem.exists(filePath))) {
      return fallback
    }

    return yield* fileSystem.readFileString(filePath).pipe(
      Effect.flatMap(Schema.decodeEffect(schema)),
      Effect.catchTag('SchemaError', (schemaError) =>
        Effect.fail(new PodFileUnreadable({ filePath, issueMessage: schemaError.message })),
      ),
    )
  })

export const writeManifest = <Manifest>(schema: Schema.Codec<Manifest, string>) =>
  Effect.fn('writeManifest')(function* (manifestPath: string, manifest: Manifest) {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temporaryManifestPath = `${manifestPath}.tmp`
    const manifestText = yield* Schema.encodeEffect(schema)(manifest)
    const unchanged =
      (yield* fileSystem.exists(manifestPath)) &&
      (yield* fileSystem.readFileString(manifestPath)) === manifestText

    if (unchanged) {
      return
    }

    yield* fileSystem.makeDirectory(path.dirname(manifestPath), {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    })
    yield* fileSystem.writeFileString(temporaryManifestPath, manifestText)
    yield* fileSystem.rename(temporaryManifestPath, manifestPath)
  })

const withTrailingLineBreak = (text: string) =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`

export const shellBlockMarkersOf = (blockName: string): BlockMarkers => [
  `# >>> pie: ${blockName} >>>\n`,
  `# <<< pie: ${blockName} <<<\n`,
]

const homeBlockMarkersOf = (homeName: string) => shellBlockMarkersOf(`home/${homeName}`)

const blockRangeOf = (text: string, [startMarker, endMarker]: BlockMarkers) => {
  const startIndex = text.indexOf(startMarker)
  const endIndex = text.indexOf(endMarker, startIndex)

  return startIndex >= 0 && endIndex >= 0
    ? Option.some({ startIndex, endIndex: endIndex + endMarker.length })
    : Option.none()
}

export const withBlock = (text: string, blockMarkers: BlockMarkers, blockContent: string) => {
  const [startMarker, endMarker] = blockMarkers
  const block = `${startMarker}${withTrailingLineBreak(blockContent)}${endMarker}`

  return Option.match(blockRangeOf(text, blockMarkers), {
    onNone: () => `${withTrailingLineBreak(text)}${block}`,
    onSome: ({ startIndex, endIndex }) =>
      `${text.slice(0, startIndex)}${block}${text.slice(endIndex)}`,
  })
}

const withoutBlock = (text: string, blockMarkers: BlockMarkers) =>
  Option.match(blockRangeOf(text, blockMarkers), {
    onNone: () => text,
    onSome: ({ startIndex, endIndex }) => `${text.slice(0, startIndex)}${text.slice(endIndex)}`,
  })

export const updateTextFile = Effect.fn('updateTextFile')(function* (
  filePath: string,
  updateText: (text: string) => string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const fileExists = yield* fileSystem.exists(filePath)
  const text = fileExists ? yield* fileSystem.readFileString(filePath) : ''
  const updatedText = updateText(text)

  if (updatedText === text) {
    return
  }

  const fileMode = fileExists
    ? (yield* fileSystem.stat(filePath)).mode & PERMISSION_BITS
    : REGULAR_FILE_MODE

  yield* writeFileIfChanged(filePath, new TextEncoder().encode(updatedText), fileMode)
})

export const homeFilesOf = (configDirectory: string, recipe: ResolvedRecipe) =>
  Effect.forEach(recipe.home, (homeFile) =>
    Effect.map(readPodFile(configDirectory, homeFile.sourcePath, homeFile.homePath), (podFile) => ({
      ...podFile,
      homeName: homeFile.homeName,
      mode: homeFile.mode,
    })),
  )

type HomeFile = Effect.Success<ReturnType<typeof homeFilesOf>>[number]

export const readHomeManifest = Effect.fn('readHomeManifest')(function* () {
  return yield* decodeJsonFile(HomeManifestJson)(yield* homeManifestPath, EMPTY_HOME_MANIFEST)
})

const copiedHomeFilesOf = (homeFiles: readonly HomeFile[]) =>
  Arr.filter(homeFiles, (homeFile) => homeFile.mode === 'copy')

const homeManifestOf = (homeFiles: readonly HomeFile[]): HomeManifest => ({
  copiedFiles: Arr.map(copiedHomeFilesOf(homeFiles), (homeFile) => homeFile.path),
  appendedBlocks: pipe(
    homeFiles,
    Arr.filter((homeFile) => homeFile.mode === 'append'),
    Arr.map((homeFile) => ({ homePath: homeFile.path, homeName: homeFile.homeName })),
  ),
})

export const failOnForeignHomeFiles = Effect.fn('failOnForeignHomeFiles')(function* (
  homeFiles: readonly HomeFile[],
  previousHomeManifest: HomeManifest,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* homeDirectory

  yield* Effect.forEach(
    Arr.filter(
      copiedHomeFilesOf(homeFiles),
      (homeFile) => !Arr.contains(previousHomeManifest.copiedFiles, homeFile.path),
    ),
    (homeFile) => {
      const filePath = path.join(home, homeFile.path)

      return fileSystem.exists(filePath).pipe(
        Effect.filterOrFail(
          (fileExists) => !fileExists,
          () => new HomeFileNotPies({ filePath, homeName: homeFile.homeName }),
        ),
      )
    },
    { discard: true },
  )
})

const updateBlocks = Effect.fn('updateBlocks')(function* (
  homePath: string,
  homeFiles: readonly HomeFile[],
  staleBlocks: readonly HomeManifest['appendedBlocks'][number][],
) {
  const path = yield* Path.Path
  const home = yield* homeDirectory
  const appendedFilesHere = Arr.filter(
    homeFiles,
    (homeFile) => homeFile.mode === 'append' && homeFile.path === homePath,
  )
  const staleBlocksHere = Arr.filter(staleBlocks, (staleBlock) => staleBlock.homePath === homePath)

  yield* updateTextFile(path.join(home, homePath), (text) =>
    Arr.reduce(
      appendedFilesHere,
      Arr.reduce(staleBlocksHere, text, (updatedText, staleBlock) =>
        withoutBlock(updatedText, homeBlockMarkersOf(staleBlock.homeName)),
      ),
      (updatedText, homeFile) =>
        withBlock(
          updatedText,
          homeBlockMarkersOf(homeFile.homeName),
          new TextDecoder().decode(homeFile.content),
        ),
    ),
  )
})

export const applyHomeFiles = Effect.fn('applyHomeFiles')(function* (
  homeFiles: readonly HomeFile[],
  previousHomeManifest: HomeManifest,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* homeDirectory
  const manifestPath = yield* homeManifestPath
  const homeManifest = homeManifestOf(homeFiles)
  const staleBlocks = Arr.differenceWith(isSameAppendedBlock)(
    previousHomeManifest.appendedBlocks,
    homeManifest.appendedBlocks,
  )

  yield* writeManifest(HomeManifestJson)(manifestPath, {
    copiedFiles: Arr.union(previousHomeManifest.copiedFiles, homeManifest.copiedFiles),
    appendedBlocks: [...homeManifest.appendedBlocks, ...staleBlocks],
  })
  yield* Effect.forEach(
    Arr.difference(previousHomeManifest.copiedFiles, homeManifest.copiedFiles),
    (homePath) => fileSystem.remove(path.join(home, homePath), { force: true }),
    { discard: true },
  )
  yield* Effect.forEach(
    copiedHomeFilesOf(homeFiles),
    (homeFile) =>
      writeFileIfChanged(
        path.join(home, homeFile.path),
        homeFile.content,
        homeFile.executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE,
      ),
    { discard: true },
  )
  yield* Effect.forEach(
    pipe(
      [...homeManifest.appendedBlocks, ...staleBlocks],
      Arr.map((block) => block.homePath),
      Arr.dedupe,
    ),
    (homePath) => updateBlocks(homePath, homeFiles, staleBlocks),
    { discard: true },
  )
  yield* writeManifest(HomeManifestJson)(manifestPath, homeManifest)
})
