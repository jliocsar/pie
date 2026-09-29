import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'
import {
  DeviceKind,
  DeviceNameTaken,
  Invite,
  InviteAlreadyUsed,
  InviteExpired,
  InviteUnknown,
} from '../Api.ts'
import { Devices } from './Devices.ts'
import { generateSecret, hashSecret } from './Secrets.ts'
import { Settings } from './Settings.ts'

const MASTER_DEVICE_NAME = 'master'

const GENERATED_NAME_BYTE_LENGTH = 3

const INVITE_LIFETIME = Duration.hours(1)

export class AlreadyBootstrapped extends Schema.TaggedError<AlreadyBootstrapped>()(
  'AlreadyBootstrapped',
  {},
) {
  override get message(): string {
    return 'pie already has an admin device. Invite more devices from it with `pie invite new`.'
  }
}

export class ServerUrlMissing extends Schema.TaggedError<ServerUrlMissing>()('ServerUrlMissing', {
  dataDirectory: Schema.String,
}) {
  override get message(): string {
    return `pie serve hasn't run with ${this.dataDirectory} yet, so there's no server URL to put in the invite. Start pie serve first.`
  }
}

const PendingInvite = Schema.Struct({
  name: Schema.String,
  kind: DeviceKind,
  recipe: Schema.OptionFromNullOr(Schema.String),
  expiresAt: Schema.Int,
  redeemedAt: Schema.OptionFromNullOr(Schema.Int),
  createdBy: Schema.OptionFromNullOr(Schema.String),
})

export class Invites extends Context.Service<Invites>()('pie/Invites', {
  make: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto
    const devices = yield* Devices
    const settings = yield* Settings
    const findPendingInvite = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PendingInvite,
      execute: (inviteHash) => sql`
        SELECT name, kind, recipe, expires_at, redeemed_at, created_by
        FROM invites
        WHERE hash = ${inviteHash}
      `,
    })

    const failWhenNameTaken = Effect.fn('Invites.failWhenNameTaken')(function* (
      deviceName: string,
    ) {
      const now = yield* Clock.currentTimeMillis
      const countNameHolders = SqlSchema.findOne({
        Request: Schema.String,
        Result: Schema.Struct({ holderCount: Schema.Int }),
        execute: (name) => sql`
          SELECT
            (SELECT count(*) FROM devices WHERE name = ${name})
            + (SELECT count(*) FROM invites
               WHERE name = ${name} AND redeemed_at IS NULL AND expires_at > ${now})
            AS holder_count
        `,
      })

      yield* countNameHolders(deviceName).pipe(
        Effect.filterOrFail(
          ({ holderCount }) => holderCount === 0,
          () => new DeviceNameTaken({ deviceName }),
        ),
      )
    })

    const insertInvite = Effect.fn('Invites.insertInvite')(
      function* (invite: {
        readonly deviceName: string
        readonly kind: DeviceKind
        readonly recipeName: Option.Option<string>
        readonly createdBy: Option.Option<string>
        readonly serverUrl: string
      }) {
        const now = yield* Clock.currentTimeMillis
        const secret = yield* generateSecret
        const inviteHash = yield* hashSecret(secret)
        const expiresAt = now + Duration.toMillis(INVITE_LIFETIME)

        yield* sql`INSERT INTO invites ${sql.insert({
          hash: inviteHash,
          name: invite.deviceName,
          kind: invite.kind,
          recipe: Option.getOrNull(invite.recipeName),
          expiresAt,
          createdBy: Option.getOrNull(invite.createdBy),
        })}`

        return {
          invite: yield* Schema.encodeEffect(Invite)({ serverUrl: invite.serverUrl, secret }),
          deviceName: invite.deviceName,
          kind: invite.kind,
          expiresAt: DateTime.makeUnsafe(expiresAt),
        }
      },
      Effect.provideService(Crypto.Crypto, crypto),
    )

    const generateDeviceName = Effect.fn('Invites.generateDeviceName')(function* (
      kind: DeviceKind,
    ) {
      const suffixBytes = yield* crypto.randomBytes(GENERATED_NAME_BYTE_LENGTH)

      return `${kind}-${Encoding.encodeHex(suffixBytes)}`
    })

    const create = Effect.fn('Invites.create')(function* (request: {
      readonly deviceName: Option.Option<string>
      readonly kind: DeviceKind
      readonly recipeName: Option.Option<string>
      readonly createdBy: string
      readonly serverUrl: string
    }) {
      const deviceName = yield* Option.match(request.deviceName, {
        onNone: () => generateDeviceName(request.kind),
        onSome: Effect.succeed,
      })

      yield* failWhenNameTaken(deviceName)

      return yield* insertInvite({
        deviceName,
        kind: request.kind,
        recipeName: request.recipeName,
        createdBy: Option.some(request.createdBy),
        serverUrl: request.serverUrl,
      })
    }, sql.withTransaction)

    const redeem = Effect.fn('Invites.redeem')(
      function* (secret: string) {
        const now = yield* Clock.currentTimeMillis
        const inviteHash = yield* hashSecret(secret)
        const invite = yield* findPendingInvite(inviteHash).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new InviteUnknown()),
              onSome: Effect.succeed,
            }),
          ),
          Effect.filterOrFail(
            (foundInvite) => Option.isNone(foundInvite.redeemedAt),
            (foundInvite) => new InviteAlreadyUsed({ deviceName: foundInvite.name }),
          ),
          Effect.filterOrFail(
            (foundInvite) => now < foundInvite.expiresAt,
            (foundInvite) =>
              new InviteExpired({
                deviceName: foundInvite.name,
                expiredAt: DateTime.makeUnsafe(foundInvite.expiresAt),
              }),
          ),
        )

        yield* sql`UPDATE invites SET redeemed_at = ${now} WHERE hash = ${inviteHash}`
        yield* failWhenNameTaken(invite.name)

        const token = yield* generateSecret
        const tokenHash = yield* hashSecret(token)

        yield* devices.insert({
          name: invite.name,
          kind: invite.kind,
          tokenHash,
          recipe: Option.getOrNull(invite.recipe),
          invitedBy: Option.getOrNull(invite.createdBy),
          lastSeenAt: now,
        })

        return {
          token,
          device: {
            name: invite.name,
            kind: invite.kind,
            recipe: invite.recipe,
            lastUpCommit: Option.none(),
            invitedBy: invite.createdBy,
            lastSeenAt: Option.some(DateTime.makeUnsafe(now)),
          },
        }
      },
      Effect.provideService(Crypto.Crypto, crypto),
      sql.withTransaction,
    )

    const bootstrapMaster = Effect.fn('Invites.bootstrapMaster')(function* (dataDirectory: string) {
      yield* devices.countAdmins.pipe(
        Effect.filterOrFail(
          (adminCount) => adminCount === 0,
          () => new AlreadyBootstrapped(),
        ),
      )

      const serverUrl = yield* settings.serverUrl.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ServerUrlMissing({ dataDirectory })),
            onSome: Effect.succeed,
          }),
        ),
      )

      yield* sql`DELETE FROM invites WHERE name = ${MASTER_DEVICE_NAME} AND redeemed_at IS NULL`

      return yield* insertInvite({
        deviceName: MASTER_DEVICE_NAME,
        kind: 'admin',
        recipeName: Option.none(),
        createdBy: Option.none(),
        serverUrl,
      })
    }, sql.withTransaction)

    return { create, redeem, bootstrapMaster }
  }),
}) {
  static readonly layer = Layer.effect(this)(this.make).pipe(
    Layer.provide(Layer.mergeAll(Devices.layer, Settings.layer)),
  )
}

export const bootstrapMasterInvite = Effect.fn('bootstrapMasterInvite')(function* (
  dataDirectory: string,
) {
  const invites = yield* Invites

  return yield* invites.bootstrapMaster(dataDirectory)
})
