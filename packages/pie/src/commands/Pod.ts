import * as Console from 'effect/Console'
import * as Effect from 'effect/Effect'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import { upPod } from '../Pod.ts'

const COMMIT_ABBREVIATION_LENGTH = 7

export const pod = Command.make('pod').pipe(
  Command.withSubcommands([
    Command.make(
      'up',
      { configRepository: Argument.String('org/repo').pipe(Argument.optional) },
      Effect.fn(function* ({ configRepository }) {
        const { recipeName, commit } = yield* upPod(configRepository)

        yield* Console.log(
          `Applied recipe ${recipeName} at config commit ${commit.slice(0, COMMIT_ABBREVIATION_LENGTH)}.`,
        )
      }),
    ),
  ]),
)
