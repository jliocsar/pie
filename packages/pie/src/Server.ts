import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqliteMigrator from '@effect/sql-sqlite-bun/SqliteMigrator'
import * as Clock from 'effect/Clock'
import * as Crypto from 'effect/Crypto'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'
import {
  AdminOnly,
  Authentication,
  CurrentDevice,
  Device,
  NotAnAdmin,
  PieApi,
  TokenMissing,
  TokenUnknown,
} from './Api.ts'

const SECRET_BYTE_LENGTH = 32

const DATABASE_FILE_NAME = 'pie.sqlite'

const BOOTSTRAP_DEVICE_NAME = 'admin'

const INVITE_LIFETIME = Duration.hours(1)

const createDevicesAndInvites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE devices (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('admin', 'pod')),
      token_hash TEXT NOT NULL UNIQUE,
      recipe TEXT,
      last_up_commit TEXT,
      invited_by TEXT,
      last_seen_at INTEGER
    )
  `
  yield* sql`
    CREATE TABLE invites (
      hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('admin', 'pod')),
      recipe TEXT,
      expires_at INTEGER NOT NULL,
      redeemed_at INTEGER,
      created_by TEXT
    )
  `
})

export const generateSecret = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const secretBytes = yield* crypto.randomBytes(SECRET_BYTE_LENGTH)

  return Encoding.encodeBase64Url(secretBytes)
})

export const hashSecret = Effect.fn('hashSecret')(function* (secret: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(secret))

  return Encoding.encodeHex(digest)
})

export const databaseLayer = (dataDirectory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* fileSystem.makeDirectory(dataDirectory, { recursive: true })

      return SqliteMigrator.layer({
        loader: SqliteMigrator.fromRecord({
          '1_create_devices_and_invites': createDevicesAndInvites,
        }),
      }).pipe(
        Layer.provideMerge(
          SqliteClient.layer({
            filename: path.join(dataDirectory, DATABASE_FILE_NAME),
            transformResultNames: Str.snakeToCamel,
            transformQueryNames: Str.camelToSnake,
          }),
        ),
      )
    }),
  )

const createBootstrapInvite = Effect.fn('createBootstrapInvite')(function* (now: number) {
  const sql = yield* SqlClient.SqlClient
  const invite = yield* generateSecret
  const inviteHash = yield* hashSecret(invite)

  yield* sql`INSERT INTO invites ${sql.insert({
    hash: inviteHash,
    name: BOOTSTRAP_DEVICE_NAME,
    kind: 'admin',
    expiresAt: now + Duration.toMillis(INVITE_LIFETIME),
  })}`
  yield* Effect.logInfo(`No devices yet. Log in within the hour with: pie login ${invite}`)

  return invite
})

export const bootstrapAdminInvite = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = yield* Clock.currentTimeMillis
  const countDevicesAndPendingInvites = SqlSchema.findOne({
    Request: Schema.Int,
    Result: Schema.Struct({ accessCount: Schema.Int }),
    execute: (currentTime) => sql`
      SELECT
        (SELECT count(*) FROM devices)
        + (SELECT count(*) FROM invites WHERE redeemed_at IS NULL AND expires_at > ${currentTime})
        AS access_count
    `,
  })
  const { accessCount } = yield* countDevicesAndPendingInvites(now)

  return yield* createBootstrapInvite(now).pipe(Effect.when(Effect.succeed(accessCount === 0)))
})

const findDeviceByTokenHash = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Device,
    execute: (tokenHash) => sql`
      SELECT name, kind, recipe, last_up_commit, invited_by, last_seen_at
      FROM devices
      WHERE token_hash = ${tokenHash}
    `,
  })
})

const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto
    const findDevice = yield* findDeviceByTokenHash

    const authenticate = Effect.fn('authenticate')(function* (credential: Redacted.Redacted) {
      const token = yield* Option.liftPredicate(Redacted.value(credential), Str.isNonEmpty).pipe(
        Option.match({ onNone: () => Effect.fail(new TokenMissing()), onSome: Effect.succeed }),
      )
      const tokenHash = yield* hashSecret(token).pipe(Effect.provideService(Crypto.Crypto, crypto))
      const device = yield* findDevice(tokenHash).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(new TokenUnknown()), onSome: Effect.succeed }),
        ),
      )
      const now = yield* Clock.currentTimeMillis

      yield* sql`UPDATE devices SET last_seen_at = ${now} WHERE name = ${device.name}`

      return device
    })

    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        authenticate(credential).pipe(
          Effect.catchTags({
            PlatformError: Effect.die,
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
          Effect.flatMap((device) => Effect.provideService(httpEffect, CurrentDevice, device)),
        ),
    })
  }),
)

const adminOnlyLayer = Layer.succeed(AdminOnly, (httpEffect) =>
  Effect.service(CurrentDevice).pipe(
    Effect.filterOrFail(
      (device) => device.kind === 'admin',
      (device) => new NotAnAdmin({ deviceName: device.name }),
    ),
    Effect.andThen(httpEffect),
  ),
)

const devicesHandlers = HttpApiBuilder.group(PieApi, 'devices', (handlers) =>
  handlers.handle('whoami', () => Effect.service(CurrentDevice)),
)

const podsHandlers = HttpApiBuilder.group(
  PieApi,
  'pods',
  Effect.fn(function* (handlers) {
    const sql = yield* SqlClient.SqlClient
    const listPods = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Device,
      execute: () => sql`
        SELECT name, kind, recipe, last_up_commit, invited_by, last_seen_at
        FROM devices
        WHERE kind = 'pod'
        ORDER BY name
      `,
    })

    return handlers.handle('list', () => listPods(undefined).pipe(Effect.orDie))
  }),
)

export const apiLayer = (dataDirectory: string) => {
  const databaseAndMiddleware = Layer.mergeAll(
    authenticationLayer,
    adminOnlyLayer,
    Layer.effectDiscard(bootstrapAdminInvite),
  ).pipe(Layer.provideMerge(databaseLayer(dataDirectory)))
  const handlers = Layer.mergeAll(devicesHandlers, podsHandlers).pipe(
    Layer.provide(databaseAndMiddleware),
  )

  return HttpApiBuilder.layer(PieApi).pipe(Layer.provide(handlers))
}
