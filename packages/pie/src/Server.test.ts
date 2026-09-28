import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import {
  CONFIG_STALE_HEADER,
  CreatedInvite,
  Device,
  Invite,
  Joined,
  PodConfig,
  type PodFile,
} from './Api.ts'
import {
  AlreadyBootstrapped,
  bootstrapMasterInvite,
  databaseLayer,
  hashSecret,
  runGit,
  ServerUrlMissing,
} from './Server.ts'
import {
  ADMIN_TOKEN,
  commitToConfigSource,
  inFreshDirectory,
  jsonRequest,
  POD_TOKEN,
  SEED_CONFIG_FILES,
  SERVER_URL,
  startPie,
  startSeededPie,
} from './test/TestPie.ts'

const ADMIN_HEADERS = { authorization: `Bearer ${ADMIN_TOKEN}` }

const POD_HEADERS = { authorization: `Bearer ${POD_TOKEN}` }

const bunServicesRuntime = ManagedRuntime.make(BunServices.layer)

const decodeResponse =
  <Decoded, Encoded>(schema: Schema.Codec<Decoded, Encoded>) =>
  (response: Response) =>
    Effect.promise(() => response.json()).pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)))

const describePodFile = (podFile: PodFile) => ({
  path: podFile.path,
  text: new TextDecoder().decode(podFile.content),
  executable: podFile.executable,
})

const bootstrapInto = (dataDirectory: string) =>
  bootstrapMasterInvite(dataDirectory).pipe(Effect.provide(databaseLayer(dataDirectory)))

const secretOf = (invite: string) =>
  Schema.decodeEffect(Invite)(invite).pipe(Effect.map((payload) => payload.secret))

afterAll(() => bunServicesRuntime.dispose())

describe('pie bootstrap', () => {
  test('pie serve records its URL, and bootstrap puts it in a master invite that joins once', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie, dataDirectory } = yield* startPie(temporaryDirectory)

          yield* requestPie('/whoami', {})

          const masterInvite = yield* bootstrapInto(dataDirectory)
          const invitePayload = yield* Schema.decodeEffect(Invite)(masterInvite.invite)
          const joined = yield* requestPie(
            '/join',
            jsonRequest('POST', {}, { secret: invitePayload.secret }),
          ).pipe(Effect.flatMap(decodeResponse(Joined)))
          const secondBootstrap = yield* Effect.flip(bootstrapInto(dataDirectory))

          expect(invitePayload.serverUrl).toBe(SERVER_URL)
          expect([joined.device.name, joined.device.kind]).toEqual(['master', 'admin'])
          expect(secondBootstrap).toBeInstanceOf(AlreadyBootstrapped)
        }),
      ),
    ))

  test('bootstrap before pie serve ever ran has no URL to hand out', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(bootstrapInto(dataDirectory))

          expect(error).toBeInstanceOf(ServerUrlMissing)
        }),
      ),
    ))

  test('a second bootstrap replaces the first unused master invite', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie, dataDirectory } = yield* startPie(temporaryDirectory)

          yield* requestPie('/whoami', {})

          const firstSecret = yield* bootstrapInto(dataDirectory).pipe(
            Effect.flatMap((created) => secretOf(created.invite)),
          )
          const secondSecret = yield* bootstrapInto(dataDirectory).pipe(
            Effect.flatMap((created) => secretOf(created.invite)),
          )
          const firstJoin = yield* requestPie(
            '/join',
            jsonRequest('POST', {}, { secret: firstSecret }),
          )
          const secondJoin = yield* requestPie(
            '/join',
            jsonRequest('POST', {}, { secret: secondSecret }),
          )

          expect([firstJoin.status, secondJoin.status]).toEqual([404, 200])
        }),
      ),
    ))
})

describe('pie serve auth', () => {
  test.each([
    {
      description: 'no token',
      path: '/whoami',
      headers: {},
      status: 401,
      errorTag: 'TokenMissing',
    },
    {
      description: 'an unknown token',
      path: '/whoami',
      headers: { authorization: 'Bearer not-a-token' },
      status: 401,
      errorTag: 'TokenUnknown',
    },
    {
      description: 'a pod token on an admin route',
      path: '/pods',
      headers: POD_HEADERS,
      status: 403,
      errorTag: 'NotAnAdmin',
    },
    {
      description: 'no token on pod config',
      path: '/pod/config',
      headers: {},
      status: 401,
      errorTag: 'TokenMissing',
    },
    {
      description: 'a device with no recipe asking for pod config',
      path: '/pod/config',
      headers: ADMIN_HEADERS,
      status: 409,
      errorTag: 'PodHasNoRecipe',
    },
  ])('$description gets $status', ({ path, headers, status, errorTag }) =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie } = yield* startSeededPie(temporaryDirectory)
          const response = yield* requestPie(path, { headers })
          const body = yield* Effect.promise(() => response.json())

          expect(response.status).toBe(status)
          expect(body).toMatchObject({ _tag: errorTag })
        }),
      ),
    ),
  )

  test('a pod token reaches /whoami, and an admin sees it as last seen', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie } = yield* startSeededPie(temporaryDirectory)
          const whoamiResponse = yield* requestPie('/whoami', { headers: POD_HEADERS })
          const whoami = yield* Effect.promise(() => whoamiResponse.json())
          const podsResponse = yield* requestPie('/pods', { headers: ADMIN_HEADERS })
          const pods = yield* decodeResponse(Schema.Array(Device))(podsResponse)

          expect(whoamiResponse.status).toBe(200)
          expect(whoami).toEqual({
            name: 'box',
            kind: 'pod',
            recipe: 'personal',
            lastUpCommit: null,
            invitedBy: 'laptop',
            lastSeenAt: null,
          })
          expect(podsResponse.status).toBe(200)
          expect(pods.map((pod) => [pod.name, Option.isSome(pod.lastSeenAt)])).toEqual([
            ['box', true],
          ])
        }),
      ),
    ))
})

describe('pie invites and join', () => {
  test('an admin invites a pod with a recipe, the pod joins once, and pods lists it', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie } = yield* startSeededPie(temporaryDirectory)
          const created = yield* requestPie(
            '/invites',
            jsonRequest('POST', ADMIN_HEADERS, {
              deviceName: 'sprite',
              recipeName: 'personal',
              kind: 'pod',
            }),
          ).pipe(Effect.flatMap(decodeResponse(CreatedInvite)))
          const secret = yield* secretOf(created.invite)
          const joined = yield* requestPie('/join', jsonRequest('POST', {}, { secret })).pipe(
            Effect.flatMap(decodeResponse(Joined)),
          )
          const reused = yield* requestPie('/join', jsonRequest('POST', {}, { secret }))
          const reusedBody = yield* Effect.promise(() => reused.json())
          const whoami = yield* requestPie('/whoami', {
            headers: { authorization: `Bearer ${joined.token}` },
          }).pipe(Effect.flatMap(decodeResponse(Device)))
          const pods = yield* requestPie('/pods', { headers: ADMIN_HEADERS }).pipe(
            Effect.flatMap(decodeResponse(Schema.Array(Device))),
          )

          expect(created.deviceName).toBe('sprite')
          expect(whoami.name).toBe('sprite')
          expect([joined.device.recipe, joined.device.invitedBy]).toEqual([
            Option.some('personal'),
            Option.some('laptop'),
          ])
          expect(reused.status).toBe(410)
          expect(reusedBody).toMatchObject({ _tag: 'InviteAlreadyUsed', deviceName: 'sprite' })
          expect(pods.map((pod) => pod.name)).toEqual(['box', 'sprite'])
        }),
      ),
    ))

  test('an invite without a name gets a generated one', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie } = yield* startSeededPie(temporaryDirectory)
          const created = yield* requestPie(
            '/invites',
            jsonRequest('POST', ADMIN_HEADERS, { deviceName: null, recipeName: null, kind: 'pod' }),
          ).pipe(Effect.flatMap(decodeResponse(CreatedInvite)))

          expect(created.deviceName).toMatch(/^pod-[0-9a-f]{6}$/u)
        }),
      ),
    ))

  test.each([
    {
      description: 'a name a device already has',
      headers: ADMIN_HEADERS,
      invite: { deviceName: 'box', recipeName: null, kind: 'pod' },
      status: 409,
      errorTag: 'DeviceNameTaken',
    },
    {
      description: 'a recipe missing from the config repo',
      headers: ADMIN_HEADERS,
      invite: { deviceName: 'sprite', recipeName: 'work', kind: 'pod' },
      status: 422,
      errorTag: 'RecipeNotFound',
    },
    {
      description: 'a pod token',
      headers: POD_HEADERS,
      invite: { deviceName: 'sprite', recipeName: null, kind: 'pod' },
      status: 403,
      errorTag: 'NotAnAdmin',
    },
  ])('an invite with $description gets $status', ({ headers, invite, status, errorTag }) =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie } = yield* startSeededPie(temporaryDirectory)
          const response = yield* requestPie('/invites', jsonRequest('POST', headers, invite))
          const body = yield* Effect.promise(() => response.json())

          expect(response.status).toBe(status)
          expect(body).toMatchObject({ _tag: errorTag })
        }),
      ),
    ),
  )

  test('a name a pending invite already holds is taken', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie } = yield* startSeededPie(temporaryDirectory)
          const invite = { deviceName: 'sprite', recipeName: null, kind: 'pod' }
          const first = yield* requestPie('/invites', jsonRequest('POST', ADMIN_HEADERS, invite))
          const second = yield* requestPie('/invites', jsonRequest('POST', ADMIN_HEADERS, invite))

          expect([first.status, second.status]).toEqual([200, 409])
        }),
      ),
    ))

  test.each([
    {
      description: 'an expired invite',
      secret: 'stored-secret',
      status: 410,
      errorTag: 'InviteExpired',
    },
    {
      description: 'an unknown invite',
      secret: 'another-secret',
      status: 404,
      errorTag: 'InviteUnknown',
    },
  ])('joining with $description gets $status', ({ secret, status, errorTag }) =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie, dataDirectory } = yield* startSeededPie(temporaryDirectory)
          const storedHash = yield* hashSecret('stored-secret')

          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient

            yield* sql`INSERT INTO invites ${sql.insert({ hash: storedHash, name: 'sprite', kind: 'pod', expiresAt: 0 })}`
          }).pipe(Effect.provide(databaseLayer(dataDirectory)))

          const response = yield* requestPie('/join', jsonRequest('POST', {}, { secret }))
          const body = yield* Effect.promise(() => response.json())

          expect(response.status).toBe(status)
          expect(body).toMatchObject({ _tag: errorTag })
        }),
      ),
    ),
  )
})

describe('pie serve config pull', () => {
  test('only config routes pull, and they say so when the pull fails', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem
          const path = yield* Path.Path
          const { requestPie, dataDirectory, sourceDirectory } =
            yield* startSeededPie(temporaryDirectory)
          const pulledFilePath = path.join(dataDirectory, 'config', 'pulled')
          const inviteRequest = (deviceName: string) =>
            requestPie(
              '/invites',
              jsonRequest('POST', ADMIN_HEADERS, { deviceName, recipeName: null, kind: 'pod' }),
            )

          yield* requestPie('/whoami', { headers: POD_HEADERS })
          yield* commitToConfigSource(sourceDirectory, { pulled: 'pulled' }, [])
          yield* requestPie('/whoami', { headers: POD_HEADERS })

          const pulledAfterWhoami = yield* fileSystem.exists(pulledFilePath)
          const freshResponse = yield* inviteRequest('fresh')
          const pulledAfterInvite = yield* fileSystem.exists(pulledFilePath)

          yield* fileSystem.remove(sourceDirectory, { recursive: true })

          const staleResponse = yield* inviteRequest('stale')

          expect([pulledAfterWhoami, pulledAfterInvite]).toEqual([false, true])
          expect(freshResponse.status).toBe(200)
          expect(freshResponse.headers.get(CONFIG_STALE_HEADER)).toBeNull()
          expect(staleResponse.status).toBe(200)
          expect(staleResponse.headers.get(CONFIG_STALE_HEADER)).toBe('true')
        }),
      ),
    ))
})

describe('pie pod config', () => {
  test('a pod gets its recipe at HEAD, reports the commit it applied, and pods lists it', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie, sourceDirectory } = yield* startSeededPie(temporaryDirectory)
          const headCommit = yield* runGit(['-C', sourceDirectory, 'rev-parse', 'HEAD'])
          const podConfig = yield* requestPie('/pod/config', { headers: POD_HEADERS }).pipe(
            Effect.flatMap(decodeResponse(PodConfig)),
          )
          const upResponse = yield* requestPie(
            '/pod/up',
            jsonRequest('POST', POD_HEADERS, { commit: podConfig.commit }),
          )
          const pods = yield* requestPie('/pods', { headers: ADMIN_HEADERS }).pipe(
            Effect.flatMap(decodeResponse(Schema.Array(Device))),
          )

          expect(podConfig.commit).toBe(headCommit.trim())
          expect(podConfig.miseConfig).toBe(
            '[tools]\n"node" = "24.19.0"\n"github:dmtrKovalenko/fff" = "0.10.6"\n',
          )
          expect(podConfig.tasks.map(describePodFile)).toEqual([
            { path: 'workspace', text: SEED_CONFIG_FILES['tasks/workspace'], executable: true },
          ])
          expect(podConfig.repositories).toEqual([
            { repo: 'jliocsar/pie', dir: 'jliocsar/pie' },
            { repo: 'jliocsar/nidus', dir: 'nidus' },
          ])
          expect(podConfig.claudeFiles.map(describePodFile)).toEqual([
            {
              path: 'agents/oracle.md',
              text: SEED_CONFIG_FILES['agents/oracle.md'],
              executable: false,
            },
            {
              path: 'skills/handoff/SKILL.md',
              text: SEED_CONFIG_FILES['skills/handoff/SKILL.md'],
              executable: false,
            },
            {
              path: 'skills/handoff/scripts/greet',
              text: SEED_CONFIG_FILES['skills/handoff/scripts/greet'],
              executable: true,
            },
          ])
          expect(podConfig.mcpServers).toEqual({
            fff: { type: 'stdio', command: 'fff-mcp', args: [] },
            docs: { type: 'http', url: 'https://docs.example/mcp' },
          })
          expect(upResponse.status).toBe(204)
          expect(pods.map((pod) => pod.lastUpCommit)).toEqual([Option.some(headCommit.trim())])
        }),
      ),
    ))

  test('a broken config at HEAD reaches the pod as the loader error', () =>
    bunServicesRuntime.runPromise(
      inFreshDirectory((temporaryDirectory) =>
        Effect.gen(function* () {
          const { requestPie, sourceDirectory } = yield* startSeededPie(temporaryDirectory)

          yield* commitToConfigSource(sourceDirectory, { 'recipes/personal.toml': 'label = ' }, [])

          const response = yield* requestPie('/pod/config', { headers: POD_HEADERS })
          const body = yield* Effect.promise(() => response.json())

          expect(response.status).toBe(422)
          expect(body).toMatchObject({
            _tag: 'ConfigFileUnparseable',
            filePath: 'recipes/personal.toml',
          })
        }),
      ),
    ))
})
