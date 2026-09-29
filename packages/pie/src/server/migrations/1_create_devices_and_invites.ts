import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export const createDevicesAndInvites = Effect.gen(function* () {
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
