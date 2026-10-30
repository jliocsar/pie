import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Config from 'effect/Config'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Predicate from 'effect/Predicate'
import * as Record from 'effect/Record'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import type { HomeFile } from './ConfigRepo.ts'

type BlockMarkers = readonly [startMarker: string, endMarker: string]

type BoxRoot = 'home' | 'configHome' | 'cacheHome'

interface OwnershipManifests<Manifest> {
  readonly union: Manifest
  readonly final: Manifest
}

interface BoxLocation {
  readonly root: BoxRoot
  readonly relativePath: string
  readonly access: 'owned' | 'appended'
}

const PERMISSION_BITS = 0o777
const HOME_MANIFEST_FILE_NAME = 'home-manifest.json'

export const REGULAR_FILE_MODE = 0o644
export const EXECUTABLE_FILE_MODE = 0o755
export const PRIVATE_DIRECTORY_MODE = 0o700

const ROOT_HOME_PATHS: Record.ReadonlyRecord<BoxRoot, string> = {
  home: '',
  configHome: '.config',
  cacheHome: '.cache',
}

export const BOX_LAYOUT = {
  claudeDirectory: { root: 'home', relativePath: '.claude', access: 'owned' },
  claudeState: { root: 'home', relativePath: '.claude.json', access: 'owned' },
  pieConfigDirectory: { root: 'configHome', relativePath: 'pie', access: 'owned' },
  miseConfigDirectory: { root: 'configHome', relativePath: 'mise', access: 'owned' },
  pieCacheDirectory: { root: 'cacheHome', relativePath: 'pie', access: 'owned' },
  pieBinary: { root: 'home', relativePath: '.local/bin/pie', access: 'owned' },
  miseBinary: { root: 'home', relativePath: '.local/bin/mise', access: 'owned' },
  miseDataDirectory: { root: 'home', relativePath: '.local/share/mise', access: 'owned' },
  workspace: { root: 'home', relativePath: 'workspace', access: 'owned' },
  profile: { root: 'home', relativePath: '.profile', access: 'appended' },
  zshrc: { root: 'home', relativePath: '.zshrc', access: 'appended' },
} as const satisfies Record.ReadonlyRecord<string, BoxLocation>

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

export const homePathOf = (location: BoxLocation) =>
  pipe(
    [ROOT_HOME_PATHS[location.root], location.relativePath],
    Arr.filter(Str.isNonEmpty),
    Arr.join('/'),
  )

export const shellPathOf = (location: BoxLocation) => `$HOME/${homePathOf(location)}`

const homePathsWith = (access: BoxLocation['access']) =>
  pipe(
    Record.values<string, BoxLocation>(BOX_LAYOUT),
    Arr.filter((location) => location.access === access),
    Arr.map(homePathOf),
  )

export const PIE_OWNED_HOME_PATHS = homePathsWith('owned')
export const APPEND_ONLY_HOME_PATHS = homePathsWith('appended')

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

const copiedHomeFilesOf = (homeFiles: readonly HomeFile[]) =>
  Arr.filter(homeFiles, (homeFile) => homeFile.mode === 'copy')

const homeManifestOf = (homeFiles: readonly HomeFile[]): HomeManifest => ({
  copiedFiles: Arr.map(copiedHomeFilesOf(homeFiles), (homeFile) => homeFile.homePath),
  appendedBlocks: pipe(
    homeFiles,
    Arr.filter((homeFile) => homeFile.mode === 'append'),
    Arr.map((homeFile) => ({ homePath: homeFile.homePath, homeName: homeFile.homeName })),
  ),
})

export class Box extends Context.Service<Box>()('pie/Box', {
  make: Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const home = yield* Config.String('HOME')
    const rootDirectories: Record.ReadonlyRecord<BoxRoot, string> = {
      home,
      configHome: yield* Config.String('XDG_CONFIG_HOME').pipe(
        Config.withDefault(path.join(home, ROOT_HOME_PATHS.configHome)),
      ),
      cacheHome: yield* Config.String('XDG_CACHE_HOME').pipe(
        Config.withDefault(path.join(home, ROOT_HOME_PATHS.cacheHome)),
      ),
    }
    const paths = Record.map(BOX_LAYOUT, (location: BoxLocation) =>
      path.join(rootDirectories[location.root], location.relativePath),
    )

    const writeFileIfChanged = Effect.fn('Box.writeFileIfChanged')(function* (
      filePath: string,
      content: string | Uint8Array,
      fileMode: number,
    ) {
      const bytes = Predicate.isString(content) ? new TextEncoder().encode(content) : content
      const unchanged =
        (yield* fileSystem.exists(filePath)) &&
        Buffer.compare(yield* fileSystem.readFile(filePath), bytes) === 0

      if (!unchanged) {
        yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true })
        yield* fileSystem.writeFile(filePath, bytes, { mode: fileMode })
      }

      const currentMode = (yield* fileSystem.stat(filePath)).mode & PERMISSION_BITS

      if (currentMode !== fileMode) {
        yield* fileSystem.chmod(filePath, fileMode)
      }
    })

    const updateTextFile = Effect.fn('Box.updateTextFile')(function* (
      filePath: string,
      updateText: (text: string) => string,
    ) {
      const fileExists = yield* fileSystem.exists(filePath)
      const text = fileExists ? yield* fileSystem.readFileString(filePath) : ''
      const updatedText = updateText(text)

      if (updatedText === text) {
        return
      }

      const fileMode = fileExists
        ? (yield* fileSystem.stat(filePath)).mode & PERMISSION_BITS
        : REGULAR_FILE_MODE

      yield* writeFileIfChanged(filePath, updatedText, fileMode)
    })

    const readJsonFile = Effect.fn('Box.readJsonFile')(function* <Decoded>(
      schema: Schema.Codec<Decoded, string>,
      filePath: string,
      fallback: Decoded,
    ) {
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

    const writeJsonFile = Effect.fn('Box.writeJsonFile')(function* <Decoded>(
      schema: Schema.Codec<Decoded, string>,
      filePath: string,
      value: Decoded,
    ) {
      const temporaryFilePath = `${filePath}.tmp`
      const jsonText = yield* Schema.encodeEffect(schema)(value)
      const unchanged =
        (yield* fileSystem.exists(filePath)) &&
        (yield* fileSystem.readFileString(filePath)) === jsonText

      if (unchanged) {
        return
      }

      yield* fileSystem.makeDirectory(path.dirname(filePath), {
        recursive: true,
        mode: PRIVATE_DIRECTORY_MODE,
      })
      yield* fileSystem.writeFileString(temporaryFilePath, jsonText)
      yield* fileSystem.rename(temporaryFilePath, filePath)
    })

    const failIfPresent = Effect.fn('Box.failIfPresent')(function* <Failure>(
      filePath: string,
      failureOf: () => Failure,
    ) {
      yield* fileSystem
        .exists(filePath)
        .pipe(Effect.filterOrFail((fileExists) => !fileExists, failureOf))
    })

    const writeOwned = Effect.fn('Box.writeOwned')(function* <Manifest, Failure, Requirements>(
      manifestJson: Schema.Codec<Manifest, string>,
      manifestPath: string,
      manifests: OwnershipManifests<Manifest>,
      applyChanges: Effect.Effect<void, Failure, Requirements>,
    ) {
      yield* writeJsonFile(manifestJson, manifestPath, manifests.union)
      yield* applyChanges
      yield* writeJsonFile(manifestJson, manifestPath, manifests.final)
    })

    return {
      home,
      paths,
      writeFileIfChanged,
      updateTextFile,
      readJsonFile,
      writeJsonFile,
      failIfPresent,
      writeOwned,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}

export class HomeSets extends Context.Service<HomeSets>()('pie/HomeSets', {
  make: Effect.gen(function* () {
    const box = yield* Box
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const manifestPath = path.join(box.paths.pieConfigDirectory, HOME_MANIFEST_FILE_NAME)

    const readManifest = Effect.fn('HomeSets.readManifest')(function* () {
      return yield* box.readJsonFile(HomeManifestJson, manifestPath, EMPTY_HOME_MANIFEST)
    })

    const failOnForeign = Effect.fn('HomeSets.failOnForeign')(function* (
      homeFiles: readonly HomeFile[],
      previousHomeManifest: HomeManifest,
    ) {
      yield* Effect.forEach(
        Arr.filter(
          copiedHomeFilesOf(homeFiles),
          (homeFile) => !Arr.contains(previousHomeManifest.copiedFiles, homeFile.homePath),
        ),
        (homeFile) => {
          const filePath = path.join(box.home, homeFile.homePath)

          return box.failIfPresent(
            filePath,
            () => new HomeFileNotPies({ filePath, homeName: homeFile.homeName }),
          )
        },
        { discard: true },
      )
    })

    const updateBlocks = Effect.fn('HomeSets.updateBlocks')(function* (
      homePath: string,
      homeFiles: readonly HomeFile[],
      staleBlocks: readonly HomeManifest['appendedBlocks'][number][],
    ) {
      const appendedFilesHere = Arr.filter(
        homeFiles,
        (homeFile) => homeFile.mode === 'append' && homeFile.homePath === homePath,
      )
      const staleBlocksHere = Arr.filter(
        staleBlocks,
        (staleBlock) => staleBlock.homePath === homePath,
      )

      yield* box.updateTextFile(path.join(box.home, homePath), (text) =>
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

    const apply = Effect.fn('HomeSets.apply')(function* (
      homeFiles: readonly HomeFile[],
      previousHomeManifest: HomeManifest,
    ) {
      const homeManifest = homeManifestOf(homeFiles)
      const staleBlocks = Arr.differenceWith(isSameAppendedBlock)(
        previousHomeManifest.appendedBlocks,
        homeManifest.appendedBlocks,
      )

      yield* box.writeOwned(
        HomeManifestJson,
        manifestPath,
        {
          union: {
            copiedFiles: Arr.union(previousHomeManifest.copiedFiles, homeManifest.copiedFiles),
            appendedBlocks: [...homeManifest.appendedBlocks, ...staleBlocks],
          },
          final: homeManifest,
        },
        Effect.gen(function* () {
          yield* Effect.forEach(
            Arr.difference(previousHomeManifest.copiedFiles, homeManifest.copiedFiles),
            (homePath) => fileSystem.remove(path.join(box.home, homePath), { force: true }),
            { discard: true },
          )
          yield* Effect.forEach(
            copiedHomeFilesOf(homeFiles),
            (homeFile) =>
              box.writeFileIfChanged(
                path.join(box.home, homeFile.homePath),
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
        }),
      )
    })

    return { readManifest, failOnForeign, apply }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(Box.layer))
}
