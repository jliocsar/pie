import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'
import { Device, type DeviceKind } from '../Api.ts'

export class Devices extends Context.Service<Devices>()('pie/Devices', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const countAdminDevices = SqlSchema.findOne({
      Request: Schema.Void,
      Result: Schema.Struct({ adminCount: Schema.Int }),
      execute: () => sql`SELECT count(*) AS admin_count FROM devices WHERE kind = 'admin'`,
    })
    const findByTokenHash = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Device,
      execute: (tokenHash) => sql`
        SELECT name, kind, recipe, last_up_commit, invited_by, last_seen_at
        FROM devices
        WHERE token_hash = ${tokenHash}
      `,
    })
    const findAllPods = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Device,
      execute: () => sql`
        SELECT name, kind, recipe, last_up_commit, invited_by, last_seen_at
        FROM devices
        WHERE kind = 'pod'
        ORDER BY name
      `,
    })

    const insert = Effect.fn('Devices.insert')(function* (device: {
      readonly name: string
      readonly kind: DeviceKind
      readonly tokenHash: string
      readonly recipe: string | null
      readonly invitedBy: string | null
      readonly lastSeenAt: number
    }) {
      yield* sql`INSERT INTO devices ${sql.insert(device)}`
    })

    const touchLastSeen = Effect.fn('Devices.touchLastSeen')(function* (deviceName: string) {
      const now = yield* Clock.currentTimeMillis

      yield* sql`UPDATE devices SET last_seen_at = ${now} WHERE name = ${deviceName}`
    })

    const recordUpCommit = Effect.fn('Devices.recordUpCommit')(function* (
      deviceName: string,
      commit: string,
    ) {
      yield* sql`UPDATE devices SET last_up_commit = ${commit} WHERE name = ${deviceName}`
    })

    return {
      countAdmins: countAdminDevices(undefined).pipe(Effect.map(({ adminCount }) => adminCount)),
      findByTokenHash,
      listPods: findAllPods(undefined),
      insert,
      touchLastSeen,
      recordUpCommit,
    }
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
