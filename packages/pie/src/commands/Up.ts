import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Command from 'effect/unstable/cli/Command'
import { applyPodConfig } from '../Pod.ts'
import { PieClient } from './PieClient.ts'

const COMMIT_ABBREVIATION_LENGTH = 7

export const abbreviateCommit = (commit: string) => commit.slice(0, COMMIT_ABBREVIATION_LENGTH)

export const pod = Command.make('pod').pipe(
  Command.withSubcommands([
    Command.make(
      'up',
      {},
      Effect.fn(
        function* () {
          const pieClient = yield* PieClient
          const client = yield* pieClient.joined
          const podConfig = yield* client.pod.config()

          yield* applyPodConfig(podConfig)
          yield* client.pod.up({ payload: { commit: podConfig.commit } })
          yield* Console.log(`Applied config commit ${abbreviateCommit(podConfig.commit)}.`)
        },
        Effect.catchTag('PodHasNoRecipe', (error) => Console.error(error.message)),
      ),
    ).pipe(Command.provide(PieClient.layer)),
  ]),
)
