import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'

const SERVER_URL_SETTING = 'server_url'

export class Settings extends Context.Service<Settings>()('pie/Settings', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const readSetting = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ value: Schema.String }),
      execute: (settingName) => sql`SELECT value FROM settings WHERE name = ${settingName}`,
    })

    const recordServerUrl = Effect.fn('Settings.recordServerUrl')(function* (serverUrl: string) {
      yield* sql`
        INSERT INTO settings (name, value) VALUES (${SERVER_URL_SETTING}, ${serverUrl})
        ON CONFLICT (name) DO UPDATE SET value = excluded.value
      `
    })

    return {
      serverUrl: readSetting(SERVER_URL_SETTING).pipe(
        Effect.map(Option.map((setting) => setting.value)),
      ),
      recordServerUrl,
    }
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
