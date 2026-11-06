import * as Arr from 'effect/Array'
import { pipe } from 'effect/Function'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import {
  Box,
  EXECUTABLE_FILE_MODE,
  REGULAR_FILE_MODE,
  shellBlockMarkersOf,
  withBlock,
  withoutBlock,
} from './Box.ts'
import type { HomeFile } from './ConfigRepo.ts'

const HOME_MANIFEST_FILE_NAME = 'home-manifest.json'

const AppendedBlock = Schema.Struct({ homePath: Schema.String, homeName: Schema.String })

const HomeManifest = Schema.Struct({
  copiedFiles: Schema.Array(Schema.String),
  appendedBlocks: Schema.Array(AppendedBlock),
})

type HomeManifest = typeof HomeManifest.Type

const HomeManifestJson = Schema.fromJsonString(HomeManifest)

const EMPTY_HOME_MANIFEST: HomeManifest = { copiedFiles: [], appendedBlocks: [] }

const isSameAppendedBlock = Schema.toEquivalence(AppendedBlock)

export class HomeFileNotPies extends Schema.TaggedError<HomeFileNotPies>()('HomeFileNotPies', {
  filePath: Schema.String,
  homeName: Schema.String,
}) {
  override get message(): string {
    return `${this.filePath} already exists, and pie didn't write it. Move it out of the way, or append to it with { name = "${this.homeName}", mode = "append" }. Then run \`pie pod up\` again.`
  }
}

const homeBlockMarkersOf = (homeName: string) => shellBlockMarkersOf(`home/${homeName}`)

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

    const prepare = Effect.fn('HomeSets.prepare')(function* (homeFiles: readonly HomeFile[]) {
      const previousHomeManifest = yield* readManifest()

      yield* failOnForeign(homeFiles, previousHomeManifest)

      return { apply: apply(homeFiles, previousHomeManifest) }
    })

    return { prepare }
  }),
}) {
  static readonly layer = Layer.effect(this, this.make)
}
