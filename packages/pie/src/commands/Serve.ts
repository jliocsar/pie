import * as Config from 'effect/Config'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import { serveLayer } from '../server/Server.ts'

const DEFAULT_HOST = '127.0.0.1'

const DEFAULT_PORT = 7430

const defaultDataDirectory = Config.String('XDG_DATA_HOME').pipe(
  Config.map((dataHome) => `${dataHome}/pie`),
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.local/share/pie`))),
)

export const dataDirectoryFlag = Flag.String('data-dir').pipe(
  Flag.withFallbackConfig(
    Config.String('PIE_DATA_DIR').pipe(Config.orElse(() => defaultDataDirectory)),
  ),
)

export const serve = Command.make(
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
    dataDirectory: dataDirectoryFlag,
    configRepositoryUrl: Flag.String('config-repo').pipe(
      Flag.withFallbackConfig(Config.String('PIE_CONFIG_REPO')),
    ),
    serverUrl: Flag.String('url').pipe(
      Flag.withFallbackConfig(Config.String('PIE_URL')),
      Flag.optional,
    ),
  },
  (settings) =>
    Layer.launch(
      serveLayer({
        ...settings,
        serverUrl: Option.getOrElse(
          settings.serverUrl,
          () => `http://${settings.host}:${settings.port}`,
        ),
      }),
    ),
)
