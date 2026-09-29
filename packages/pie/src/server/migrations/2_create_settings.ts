import * as Effect from 'effect/Effect'
import * as SqlClient from 'effect/unstable/sql/SqlClient'

export const createSettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `
})
