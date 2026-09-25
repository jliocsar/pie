import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { Device } from './Api.ts'
import { apiLayer, bootstrapAdminInvite, databaseLayer, hashSecret } from './Server.ts'

const ADMIN_TOKEN = 'admin-token'

const POD_TOKEN = 'pod-token'

const bunServicesRuntime = ManagedRuntime.make(BunServices.layer)

const inFreshDataDirectory = <Success, Failure, Requirements>(
  useDataDirectory: (dataDirectory: string) => Effect.Effect<Success, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem
    const dataDirectory = yield* fileSystem.makeTempDirectoryScoped()

    return yield* useDataDirectory(dataDirectory)
  }).pipe(Effect.scoped)

const bootInto = (dataDirectory: string) =>
  bootstrapAdminInvite.pipe(Effect.provide(databaseLayer(dataDirectory)))

const seedDevices = (dataDirectory: string) =>
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

const startSeededPie = (dataDirectory: string) =>
  seedDevices(dataDirectory).pipe(
    Effect.andThen(
      Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            apiLayer(dataDirectory).pipe(Layer.provide(BunHttpServer.layerHttpServices)),
            { disableLogger: true },
          ),
        ),
        ({ dispose }) => Effect.promise(dispose),
      ),
    ),
    Effect.map(
      ({ handler }) =>
        (path: string, headers: Record<string, string>) =>
          Effect.promise(() => handler(new Request(`http://pie.test${path}`, { headers }))),
    ),
  )

afterAll(() => bunServicesRuntime.dispose())

describe('bootstrapAdminInvite', () => {
  test('a fresh data dir gets one admin invite, and a restart gets none', () =>
    bunServicesRuntime.runPromise(
      inFreshDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const firstBoot = yield* bootInto(dataDirectory)
          const secondBoot = yield* bootInto(dataDirectory)

          expect(Option.isSome(firstBoot)).toBe(true)
          expect(secondBoot).toEqual(Option.none())
        }),
      ),
    ))

  test('a data dir with a device gets no invite', () =>
    bunServicesRuntime.runPromise(
      inFreshDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient
          const tokenHash = yield* hashSecret('some-token')

          yield* sql`INSERT INTO devices ${sql.insert({ name: 'laptop', kind: 'admin', tokenHash })}`

          expect(yield* bootstrapAdminInvite).toEqual(Option.none())
        }).pipe(Effect.provide(databaseLayer(dataDirectory))),
      ),
    ))

  test('an expired, unused bootstrap invite gets replaced on restart', () =>
    bunServicesRuntime.runPromise(
      inFreshDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient

          yield* sql`INSERT INTO invites ${sql.insert({ hash: 'expired', name: 'admin', kind: 'admin', expiresAt: 0 })}`

          expect(Option.isSome(yield* bootstrapAdminInvite)).toBe(true)
        }).pipe(Effect.provide(databaseLayer(dataDirectory))),
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
      headers: { authorization: `Bearer ${POD_TOKEN}` },
      status: 403,
      errorTag: 'NotAnAdmin',
    },
  ])('$description gets $status', ({ path, headers, status, errorTag }) =>
    bunServicesRuntime.runPromise(
      inFreshDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const requestPie = yield* startSeededPie(dataDirectory)
          const response = yield* requestPie(path, headers)
          const body = yield* Effect.promise(() => response.json())

          expect(response.status).toBe(status)
          expect(body).toMatchObject({ _tag: errorTag })
        }),
      ),
    ),
  )

  test('a pod token reaches /whoami, and an admin sees it as last seen', () =>
    bunServicesRuntime.runPromise(
      inFreshDataDirectory((dataDirectory) =>
        Effect.gen(function* () {
          const requestPie = yield* startSeededPie(dataDirectory)
          const whoamiResponse = yield* requestPie('/whoami', {
            authorization: `Bearer ${POD_TOKEN}`,
          })
          const whoami = yield* Effect.promise(() => whoamiResponse.json())
          const podsResponse = yield* requestPie('/pods', {
            authorization: `Bearer ${ADMIN_TOKEN}`,
          })
          const pods = yield* Effect.promise(() => podsResponse.json()).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Device))),
          )

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
