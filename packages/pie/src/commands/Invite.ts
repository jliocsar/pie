import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import { PieClient } from './PieClient.ts'

const SETUP_SCRIPT_URL = 'https://github.com/jliocsar/pie/releases/latest/download/setup.sh'

export const setupLineOf = (createdInvite: { readonly invite: string; readonly kind: string }) =>
  createdInvite.kind === 'admin'
    ? `pie join ${createdInvite.invite}`
    : `curl -fsSL ${SETUP_SCRIPT_URL} | sh -s -- ${createdInvite.invite}`

export const describeInvite = (createdInvite: {
  readonly deviceName: string
  readonly kind: string
  readonly expiresAt: DateTime.Utc
}) =>
  `Invite for ${createdInvite.deviceName} (${createdInvite.kind}), single-use, expires at ${DateTime.formatIso(createdInvite.expiresAt)}.`

export const invite = Command.make('invite').pipe(
  Command.withSubcommands([
    Command.make(
      'new',
      {
        deviceName: Flag.String('name').pipe(Flag.optional),
        recipeName: Flag.String('recipe').pipe(Flag.optional),
        admin: Flag.Boolean('admin').pipe(Flag.withDefault(false)),
      },
      Effect.fn(function* ({ deviceName, recipeName, admin }) {
        const pieClient = yield* PieClient
        const client = yield* pieClient.joined
        const createdInvite = yield* client.invites.create({
          payload: { deviceName, recipeName, kind: admin ? 'admin' : 'pod' },
        })

        yield* Console.log(setupLineOf(createdInvite))
        yield* Console.error(describeInvite(createdInvite))
      }),
    ).pipe(Command.provide(PieClient.layer)),
  ]),
)
