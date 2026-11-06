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

type BlockMarkers = readonly [startMarker: string, endMarker: string]

type BoxRoot = 'home' | 'configHome' | 'cacheHome'

interface OwnershipManifests<Manifest> {
  readonly union: Manifest
  readonly final: Manifest
}

interface BoxFile {
  readonly content: string | Uint8Array
  readonly executable: boolean
}

interface BoxLocation {
  readonly root: BoxRoot
  readonly relativePath: string
  readonly access: 'owned' | 'appended'
}

const PERMISSION_BITS = 0o777
const REGULAR_FILE_MODE = 0o644
const EXECUTABLE_FILE_MODE = 0o755
const PRIVATE_DIRECTORY_MODE = 0o700

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

class PodFileUnreadable extends Schema.TaggedError<PodFileUnreadable>()('PodFileUnreadable', {
  filePath: Schema.String,
  issueMessage: Schema.String,
}) {
  override get message(): string {
    return `${this.filePath} isn't the JSON pie expected: ${this.issueMessage}`
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

const homePathsByAccess: Record.ReadonlyRecord<BoxLocation['access'], readonly string[]> = {
  owned: homePathsWith('owned'),
  appended: homePathsWith('appended'),
}

export const PIE_OWNED_HOME_PATHS = homePathsByAccess.owned
export const APPEND_ONLY_HOME_PATHS = homePathsByAccess.appended

const withTrailingLineBreak = (text: string) =>
  text === '' || text.endsWith('\n') ? text : `${text}\n`

export const shellBlockMarkersOf = (blockName: string): BlockMarkers => [
  `# >>> pie: ${blockName} >>>\n`,
  `# <<< pie: ${blockName} <<<\n`,
]

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

export const withoutBlock = (text: string, blockMarkers: BlockMarkers) =>
  Option.match(blockRangeOf(text, blockMarkers), {
    onNone: () => text,
    onSome: ({ startIndex, endIndex }) => `${text.slice(0, startIndex)}${text.slice(endIndex)}`,
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

    const makePieConfigDirectory = fileSystem.makeDirectory(paths.pieConfigDirectory, {
      recursive: true,
      mode: PRIVATE_DIRECTORY_MODE,
    })

    const writeWithModeIfChanged = Effect.fn('Box.writeWithModeIfChanged')(function* (
      filePath: string,
      content: BoxFile['content'],
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

    const writeFileIfChanged = (filePath: string, { content, executable }: BoxFile) =>
      writeWithModeIfChanged(
        filePath,
        content,
        executable ? EXECUTABLE_FILE_MODE : REGULAR_FILE_MODE,
      )

    const pieConfigPathOf = (fileName: string) => path.join(paths.pieConfigDirectory, fileName)

    const writePieConfigFile = Effect.fn('Box.writePieConfigFile')(function* (
      fileName: string,
      text: string,
    ) {
      yield* makePieConfigDirectory
      yield* writeFileIfChanged(pieConfigPathOf(fileName), { content: text, executable: false })
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

      yield* writeWithModeIfChanged(filePath, updatedText, fileMode)
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

      yield* makePieConfigDirectory
      yield* fileSystem.writeFileString(temporaryFilePath, jsonText)
      yield* fileSystem.rename(temporaryFilePath, filePath)
    })

    const writeOwned = Effect.fn('Box.writeOwned')(function* <Manifest, Failure, Requirements>(
      manifestJson: Schema.Codec<Manifest, string>,
      manifestFileName: string,
      manifests: OwnershipManifests<Manifest>,
      applyChanges: Effect.Effect<void, Failure, Requirements>,
    ) {
      const manifestPath = pieConfigPathOf(manifestFileName)

      yield* writeJsonFile(manifestJson, manifestPath, manifests.union)
      yield* applyChanges
      yield* writeJsonFile(manifestJson, manifestPath, manifests.final)
    })

    return {
      home,
      paths,
      pieConfigPathOf,
      writePieConfigFile,
      writeFileIfChanged,
      updateTextFile,
      readJsonFile,
      writeOwned,
    }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
