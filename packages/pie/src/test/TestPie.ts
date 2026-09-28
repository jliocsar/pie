import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as Arr from 'effect/Array'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { apiLayer, databaseLayer, hashSecret, runGit } from '../Server.ts'

export const ADMIN_TOKEN = 'admin-token'

export const POD_TOKEN = 'pod-token'

export const SERVER_URL = 'http://pie.test'

const REGULAR_FILE_MODE = 0o644

const EXECUTABLE_FILE_MODE = 0o755

export const SEED_CONFIG_FILES = {
  'recipes/personal.toml': `label = "Personal"
environment = "personal"
repositories = ["jliocsar/pie", { repo = "jliocsar/nidus", dir = "nidus" }]
agents = ["oracle"]
skills = ["handoff"]
mcp = ["fff", "docs"]
`,
  'environments/personal.toml': `label = "Personal"
tasks = ["workspace"]

[tools]
node = "24.19.0"
"github:dmtrKovalenko/fff" = "0.10.6"
`,
  'mcp/fff.toml': 'command = "fff-mcp"\n',
  'mcp/docs.toml': 'url = "https://docs.example/mcp"\n',
  'agents/oracle.md': '---\nname: oracle\ndescription: answers questions\n---\nYou answer.\n',
  'agents/unused.md': '---\nname: unused\ndescription: in no recipe\n---\n',
  'skills/handoff/SKILL.md': '---\nname: handoff\ndescription: writes a handoff\n---\nWrite.\n',
  'skills/handoff/scripts/greet': '#!/bin/sh\necho hi\n',
  'tasks/workspace': '#!/bin/sh\nmkdir -p "$HOME/workspace"\n',
} satisfies Record.ReadonlyRecord<string, string>

export const SEED_EXECUTABLE_FILE_PATHS = ['skills/handoff/scripts/greet', 'tasks/workspace']

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

export const commitToConfigSource = Effect.fn('commitToConfigSource')(function* (
  sourceDirectory: string,
  configFiles: Record.ReadonlyRecord<string, string>,
  executableFilePaths: readonly string[],
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  yield* Effect.forEach(
    Record.toEntries(configFiles),
    ([filePath, content]) => {
      const absoluteFilePath = path.join(sourceDirectory, filePath)

      return fileSystem.makeDirectory(path.dirname(absoluteFilePath), { recursive: true }).pipe(
        Effect.andThen(
          fileSystem.writeFileString(absoluteFilePath, content, {
            mode: Arr.contains(executableFilePaths, filePath)
              ? EXECUTABLE_FILE_MODE
              : REGULAR_FILE_MODE,
          }),
        ),
      )
    },
    { discard: true },
  )
  yield* runGit(['-C', sourceDirectory, 'add', '--all'])
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
    Record.keys(configFiles).join(' '),
  ])
})

export const startPie = Effect.fn('startPie')(function* (temporaryDirectory: string) {
  const path = yield* Path.Path
  const dataDirectory = path.join(temporaryDirectory, 'data')
  const sourceDirectory = path.join(temporaryDirectory, 'source')

  yield* runGit(['init', '--quiet', sourceDirectory])
  yield* commitToConfigSource(sourceDirectory, SEED_CONFIG_FILES, SEED_EXECUTABLE_FILE_PATHS)

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
