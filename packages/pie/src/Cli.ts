import * as Config from 'effect/Config'
import * as Effect from 'effect/Effect'
import * as Layer from 'effect/Layer'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import { serveLayer } from './Server.ts'

const DEFAULT_HOST = '127.0.0.1'

const DEFAULT_PORT = 7430

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

const defaultDataDirectory = Config.String('XDG_DATA_HOME').pipe(
  Config.map((dataHome) => `${dataHome}/pie`),
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.local/share/pie`))),
)

const serve = Command.make(
  'serve',
  {
    host: Flag.String('host').pipe(
      Flag.withFallbackConfig(Config.String('PIE_HOST')),
      Flag.withDefault(DEFAULT_HOST),
    ),
    port: Flag.Int('port').pipe(
      Flag.withFallbackConfig(Config.Port('PIE_PORT')),
      Flag.withDefault(DEFAULT_PORT),
    ),
    dataDirectory: Flag.String('data-dir').pipe(
      Flag.withFallbackConfig(
        Config.String('PIE_DATA_DIR').pipe(Config.orElse(() => defaultDataDirectory)),
      ),
    ),
    configRepositoryUrl: Flag.String('config-repo').pipe(
      Flag.withFallbackConfig(Config.String('PIE_CONFIG_REPO')),
    ),
  },
  (settings) => Layer.launch(serveLayer(settings)),
)

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
