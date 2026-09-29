import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import { Invite } from '../Api.ts'
import { PieClient } from './PieClient.ts'

export class InviteUnreadable extends Schema.TaggedError<InviteUnreadable>()(
  'InviteUnreadable',
  {},
) {
  override get message(): string {
    return "That isn't a pie invite. Copy the whole line that `pie invite new` printed."
  }
}

export const join = Command.make(
  'join',
  { invite: Argument.String('invite') },
  Effect.fn(function* ({ invite }) {
    const pieClient = yield* PieClient
    const { serverUrl, secret } = yield* Schema.decodeEffect(Invite)(invite.trim()).pipe(
      Effect.catchTags({ SchemaError: () => Effect.fail(new InviteUnreadable()) }),
    )
    const client = yield* pieClient.forServer(serverUrl, Option.none())
    const { token, device } = yield* client.join.join({ payload: { secret } })

    yield* pieClient.saveCredentials(serverUrl, token)
    yield* Console.log(`Joined pie at ${serverUrl} as ${device.name} (${device.kind}).`)
  }),
).pipe(Command.provide(PieClient.layer))
