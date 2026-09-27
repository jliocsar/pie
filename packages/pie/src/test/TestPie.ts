import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { apiLayer, databaseLayer, hashSecret, runGit } from '../Server.ts'

export const ADMIN_TOKEN = 'admin-token'

export const POD_TOKEN = 'pod-token'

export const SERVER_URL = 'http://pie.test'

export const inFreshDirectory = <Success, Failure, Requirements>(
  useDirectory: (temporaryDirectory: string) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const temporaryDirectory = yield* fileSystem.makeTempDirectoryScoped()

    return yield* useDirectory(temporaryDirectory)
  }).pipe(Effect.scoped)

export const seedDevices = (dataDirectory: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const adminTokenHash = yield* hashSecret(ADMIN_TOKEN)
    const podTokenHash = yield* hashSecret(POD_TOKEN)

    yield* sql`INSERT INTO devices ${sql.insert([
      { name: 'laptop', kind: 'admin', tokenHash: adminTokenHash, recipe: null, invitedBy: null },
      {
        name: 'box',
        kind: 'pod',
        tokenHash: podTokenHash,
        recipe: 'personal',
        invitedBy: 'laptop',
      },
    ])}`
  }).pipe(Effect.provide(databaseLayer(dataDirectory)))

export const commitToConfigSource = (sourceDirectory: string, filePath: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absoluteFilePath = path.join(sourceDirectory, filePath)

    yield* fileSystem.makeDirectory(path.dirname(absoluteFilePath), { recursive: true })
    yield* fileSystem.writeFileString(absoluteFilePath, filePath)
    yield* runGit(['-C', sourceDirectory, 'add', filePath])
    yield* runGit([
      '-C',
      sourceDirectory,
      '-c',
      'user.name=pie',
      '-c',
      'user.email=pie@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--quiet',
      '--message',
      filePath,
    ])
  })

export const startPie = Effect.fn('startPie')(function* (temporaryDirectory: string) {
  const path = yield* Path.Path
  const dataDirectory = path.join(temporaryDirectory, 'data')
  const sourceDirectory = path.join(temporaryDirectory, 'source')

  yield* runGit(['init', '--quiet', sourceDirectory])
  yield* commitToConfigSource(sourceDirectory, 'recipes/personal.toml')

  const { handler } = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        apiLayer({
          dataDirectory,
          configRepositoryUrl: sourceDirectory,
          serverUrl: SERVER_URL,
        }).pipe(Layer.provide(BunHttpServer.layerHttpServices)),
        { disableLogger: true },
      ),
    ),
    ({ dispose }) => Effect.promise(dispose),
  )
  const fetchPie = (input: string | URL | Request, init: RequestInit | undefined) =>
    handler(input instanceof Request ? input : new Request(input.toString(), init))
  const requestPie = (requestPath: string, init: RequestInit) =>
    Effect.promise(() => fetchPie(`${SERVER_URL}${requestPath}`, init))

  return { requestPie, fetchPie, dataDirectory, sourceDirectory }
})

export const startSeededPie = Effect.fn('startSeededPie')(function* (temporaryDirectory: string) {
  const path = yield* Path.Path

  yield* seedDevices(path.join(temporaryDirectory, 'data'))

  return yield* startPie(temporaryDirectory)
})

export const jsonRequest = (
  method: string,
  headers: Record<string, string>,
  body: Readonly<Record<string, string | null>>,
) => ({
  method,
  headers: { ...headers, 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
