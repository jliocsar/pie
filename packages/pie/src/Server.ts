import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqliteMigrator from '@effect/sql-sqlite-bun/SqliteMigrator'
import * as Clock from 'effect/Clock'
import * as Crypto from 'effect/Crypto'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Str from 'effect/String'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

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
