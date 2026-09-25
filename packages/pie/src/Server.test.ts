import * as BunServices from '@effect/platform-bun/BunServices'
import { afterAll, describe, expect, test } from 'bun:test'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as ManagedRuntime from 'effect/ManagedRuntime'
import * as Option from 'effect/Option'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import { bootstrapAdminInvite, databaseLayer, hashSecret } from './Server.ts'

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
