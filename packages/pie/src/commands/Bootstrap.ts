import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Command from 'effect/unstable/cli/Command'
import { databaseLayer } from '../server/Database.ts'
import { bootstrapMasterInvite, Invites } from '../server/Invites.ts'
import { describeInvite, setupLineOf } from './Invite.ts'
import { dataDirectoryFlag } from './Serve.ts'

export const bootstrap = Command.make(
  'bootstrap',
  { dataDirectory: dataDirectoryFlag },
  Effect.fn(function* ({ dataDirectory }) {
    const createdInvite = yield* bootstrapMasterInvite(dataDirectory).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide
      Effect.provide(Invites.layer.pipe(Layer.provide(databaseLayer(dataDirectory)))),
    )

    yield* Console.log(setupLineOf(createdInvite))
    yield* Console.error(describeInvite(createdInvite))
  }),
)
