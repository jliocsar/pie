import * as Arr from 'effect/Array'
import * as Config from 'effect/Config'
import * as Console from 'effect/Console'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Schema from 'effect/Schema'
import * as Argument from 'effect/unstable/cli/Argument'
import * as Command from 'effect/unstable/cli/Command'
import * as Flag from 'effect/unstable/cli/Flag'
import * as HttpClient from 'effect/unstable/http/HttpClient'
import * as HttpClientRequest from 'effect/unstable/http/HttpClientRequest'
import * as HttpApiClient from 'effect/unstable/httpapi/HttpApiClient'
import packageJson from '../package.json' with { type: 'json' }
import { CLIENT_VERSION_HEADER, type Device, Invite, PieApi } from './Api.ts'
import { applyPodConfig, configHome } from './Pod.ts'
import { databaseLayer } from './server/Database.ts'
import { bootstrapMasterInvite, serveLayer } from './Server.ts'

const DEFAULT_HOST = '127.0.0.1'

const DEFAULT_PORT = 7430

const SETUP_SCRIPT_URL = 'https://github.com/jliocsar/pie/releases/latest/download/setup.sh'

const TOKEN_FILE_NAME = 'token'

const SERVER_URL_FILE_NAME = 'url'

const PRIVATE_DIRECTORY_MODE = 0o700

const PRIVATE_FILE_MODE = 0o600

const COMMIT_ABBREVIATION_LENGTH = 7

const COLUMN_GAP = '  '

export class NotJoined extends Schema.TaggedError<NotJoined>()('NotJoined', {
  configDirectory: Schema.String,
}) {
  override get message(): string {
    return `This machine hasn't joined pie yet: ${this.configDirectory} has no token. Run \`pie join <invite>\` first.`
  }
}

export class InviteUnreadable extends Schema.TaggedError<InviteUnreadable>()(
  'InviteUnreadable',
  {},
) {
  override get message(): string {
    return "That isn't a pie invite. Copy the whole line that `pie invite new` printed."
  }
}

const AGE_UNITS = [
  { suffix: 'd', toUnits: Duration.toDays },
  { suffix: 'h', toUnits: Duration.toHours },
  { suffix: 'm', toUnits: Duration.toMinutes },
]

const describeAge = (age: Duration.Duration) =>
  Arr.findFirst(AGE_UNITS, (unit) => unit.toUnits(age) >= 1).pipe(
    Option.match({
      onNone: () => 'just now',
      onSome: (unit) => `${Math.floor(unit.toUnits(age))}${unit.suffix} ago`,
    }),
  )

const podRowOf = (pod: Device, now: DateTime.Utc) => [
  pod.name,
  Option.getOrElse(pod.recipe, () => '-'),
  pod.lastUpCommit.pipe(
    Option.map((commit) => commit.slice(0, COMMIT_ABBREVIATION_LENGTH)),
    Option.getOrElse(() => '-'),
  ),
  Option.getOrElse(pod.invitedBy, () => '-'),
  Option.match(pod.lastSeenAt, {
    onNone: () => 'never',
    onSome: (lastSeenAt) => describeAge(DateTime.distance(lastSeenAt, now)),
  }),
]

const renderTable = (header: readonly string[], rows: readonly (readonly string[])[]) => {
  const columnWidths = Arr.reduce(
    rows,
    Arr.map(header, (heading) => heading.length),
    (widths, row) => Arr.zipWith(widths, row, (width, cell) => Math.max(width, cell.length)),
  )

  return Arr.map([header, ...rows], (row) =>
    Arr.zipWith(row, columnWidths, (cell, width) => cell.padEnd(width))
      .join(COLUMN_GAP)
      .trimEnd(),
  ).join('\n')
}

const setupLineOf = (createdInvite: { readonly invite: string; readonly kind: string }) =>
  createdInvite.kind === 'admin'
    ? `pie join ${createdInvite.invite}`
    : `curl -fsSL ${SETUP_SCRIPT_URL} | sh -s -- ${createdInvite.invite}`

const describeInvite = (createdInvite: {
  readonly deviceName: string
  readonly kind: string
  readonly expiresAt: DateTime.Utc
}) =>
  `Invite for ${createdInvite.deviceName} (${createdInvite.kind}), single-use, expires at ${DateTime.formatIso(createdInvite.expiresAt)}.`

const defaultDataDirectory = Config.String('XDG_DATA_HOME').pipe(
  Config.map((dataHome) => `${dataHome}/pie`),
  Config.orElse(() => Config.String('HOME').pipe(Config.map((home) => `${home}/.local/share/pie`))),
)

const pieConfigDirectory = configHome.pipe(
  Config.map((configDirectory) => `${configDirectory}/pie`),
)

const credentialPaths = Effect.gen(function* () {
  const path = yield* Path.Path
  const configDirectory = yield* pieConfigDirectory

  return {
    configDirectory,
    tokenPath: path.join(configDirectory, TOKEN_FILE_NAME),
    serverUrlPath: path.join(configDirectory, SERVER_URL_FILE_NAME),
  }
})

const saveCredentials = Effect.fn('saveCredentials')(function* (serverUrl: string, token: string) {
  const fileSystem = yield* FileSystem.FileSystem
  const { configDirectory, tokenPath, serverUrlPath } = yield* credentialPaths

  yield* fileSystem.makeDirectory(configDirectory, {
    recursive: true,
    mode: PRIVATE_DIRECTORY_MODE,
  })
  yield* fileSystem.remove(tokenPath, { force: true })
  yield* fileSystem.writeFileString(tokenPath, `${token}\n`, { mode: PRIVATE_FILE_MODE })
  yield* fileSystem.writeFileString(serverUrlPath, `${serverUrl}\n`)
})

const loadCredentials = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem
  const { configDirectory, tokenPath, serverUrlPath } = yield* credentialPaths
  const tokenExists = yield* fileSystem.exists(tokenPath)
  const serverUrlExists = yield* fileSystem.exists(serverUrlPath)

  if (tokenExists && serverUrlExists) {
    return {
      token: (yield* fileSystem.readFileString(tokenPath)).trim(),
      serverUrl: (yield* fileSystem.readFileString(serverUrlPath)).trim(),
    }
  }

  return yield* new NotJoined({ configDirectory })
})

const makePieClient = (serverUrl: string, token: Option.Option<string>) =>
  HttpApiClient.make(PieApi, {
    baseUrl: serverUrl,
    transformClient: HttpClient.mapRequest((request) =>
      Option.match(token, {
        onNone: () => request,
        onSome: (bearerToken) => HttpClientRequest.bearerToken(request, bearerToken),
      }).pipe(HttpClientRequest.setHeader(CLIENT_VERSION_HEADER, packageJson.version)),
    ),
  })

const makeJoinedClient = Effect.gen(function* () {
  const credentials = yield* loadCredentials

  return yield* makePieClient(credentials.serverUrl, Option.some(credentials.token))
})

const dataDirectoryFlag = Flag.String('data-dir').pipe(
  Flag.withFallbackConfig(
    Config.String('PIE_DATA_DIR').pipe(Config.orElse(() => defaultDataDirectory)),
  ),
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

const bootstrap = Command.make(
  'bootstrap',
  { dataDirectory: dataDirectoryFlag },
  Effect.fn(function* ({ dataDirectory }) {
    const createdInvite = yield* bootstrapMasterInvite(dataDirectory).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide
      Effect.provide(databaseLayer(dataDirectory)),
    )

    yield* Console.log(setupLineOf(createdInvite))
    yield* Console.error(describeInvite(createdInvite))
  }),
)

const join = Command.make(
  'join',
  { invite: Argument.String('invite') },
  Effect.fn(function* ({ invite }) {
    const { serverUrl, secret } = yield* Schema.decodeEffect(Invite)(invite.trim()).pipe(
      Effect.catchTags({ SchemaError: () => Effect.fail(new InviteUnreadable()) }),
    )
    const client = yield* makePieClient(serverUrl, Option.none())
    const { token, device } = yield* client.join.join({ payload: { secret } })

    yield* saveCredentials(serverUrl, token)
    yield* Console.log(`Joined pie at ${serverUrl} as ${device.name} (${device.kind}).`)
  }),
)

const invite = Command.make('invite').pipe(
  Command.withSubcommands([
    Command.make(
      'new',
      {
        deviceName: Flag.String('name').pipe(Flag.optional),
        recipeName: Flag.String('recipe').pipe(Flag.optional),
        admin: Flag.Boolean('admin').pipe(Flag.withDefault(false)),
      },
      Effect.fn(function* ({ deviceName, recipeName, admin }) {
        const client = yield* makeJoinedClient
        const createdInvite = yield* client.invites.create({
          payload: { deviceName, recipeName, kind: admin ? 'admin' : 'pod' },
        })

        yield* Console.log(setupLineOf(createdInvite))
        yield* Console.error(describeInvite(createdInvite))
      }),
    ),
  ]),
)

const pods = Command.make('pods').pipe(
  Command.withSubcommands([
    Command.make(
      'ls',
      {},
      Effect.fn(function* () {
        const client = yield* makeJoinedClient
        const podList = yield* client.pods.list()
        const now = yield* DateTime.now

        if (Arr.isReadonlyArrayNonEmpty(podList)) {
          return yield* Console.log(
            renderTable(
              ['NAME', 'RECIPE', 'COMMIT', 'INVITED BY', 'LAST SEEN'],
              Arr.map(podList, (pod) => podRowOf(pod, now)),
            ),
          )
        }

        return yield* Console.error('No pods yet. Invite one with `pie invite new`.')
      }),
    ),
  ]),
)

const pod = Command.make('pod').pipe(
  Command.withSubcommands([
    Command.make(
      'up',
      {},
      Effect.fn(
        function* () {
          const client = yield* makeJoinedClient
          const podConfig = yield* client.pod.config()

          yield* applyPodConfig(podConfig)
          yield* client.pod.up({ payload: { commit: podConfig.commit } })
          yield* Console.log(
            `Applied config commit ${podConfig.commit.slice(0, COMMIT_ABBREVIATION_LENGTH)}.`,
          )
        },
        Effect.catchTag('PodHasNoRecipe', (error) => Console.error(error.message)),
      ),
    ),
  ]),
)

export const pie = Command.make('pie').pipe(
  Command.withSubcommands([serve, bootstrap, join, invite, pods, pod]),
)
