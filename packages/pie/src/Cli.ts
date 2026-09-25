import * as Effect from 'effect/Effect'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'

export class CommandNotBuiltYet extends Schema.TaggedError<CommandNotBuiltYet>()(
  'CommandNotBuiltYet',
  {
    commandPath: Schema.String,
  },
) {
  override get message(): string {
    return `pie ${this.commandPath} isn't built yet.`
  }
}

const failAsNotBuiltYet = (commandPath: string) => () =>
  Effect.fail(new CommandNotBuiltYet({ commandPath }))

const serve = Command.make('serve', {}, failAsNotBuiltYet('serve'))

const login = Command.make(
  'login',
  { invite: Argument.String('invite') },
  failAsNotBuiltYet('login'),
)

const invite = Command.make('invite').pipe(
  Command.withSubcommands([Command.make('new', {}, failAsNotBuiltYet('invite new'))]),
)

const pods = Command.make('pods').pipe(
  Command.withSubcommands([Command.make('ls', {}, failAsNotBuiltYet('pods ls'))]),
)

const pod = Command.make('pod').pipe(
  Command.withSubcommands([Command.make('up', {}, failAsNotBuiltYet('pod up'))]),
)

export const pie = Command.make('pie').pipe(
  Command.withSubcommands([serve, login, invite, pods, pod]),
)
