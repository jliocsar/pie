import * as BunHttpServer from '@effect/platform-bun/BunHttpServer'
import * as SqliteClient from '@effect/sql-sqlite-bun/SqliteClient'
import * as SqliteMigrator from '@effect/sql-sqlite-bun/SqliteMigrator'
import * as Arr from 'effect/Array'
import * as Clock from 'effect/Clock'
import * as Context from 'effect/Context'
import * as Crypto from 'effect/Crypto'
import * as DateTime from 'effect/DateTime'
import * as Duration from 'effect/Duration'
import * as Effect from 'effect/Effect'
import * as Encoding from 'effect/Encoding'
import { identity } from 'effect/Function'
import * as FileSystem from 'effect/FileSystem'
import * as Layer from 'effect/Layer'
import * as Option from 'effect/Option'
import * as Path from 'effect/Path'
import * as Record from 'effect/Record'
import type { PlatformError } from 'effect/PlatformError'
import * as Redacted from 'effect/Redacted'
import * as Schema from 'effect/Schema'
import * as Semaphore from 'effect/Semaphore'
import * as Stream from 'effect/Stream'
import * as Str from 'effect/String'
import * as Headers from 'effect/unstable/http/Headers'
import * as HttpMiddleware from 'effect/unstable/http/HttpMiddleware'
import * as HttpRouter from 'effect/unstable/http/HttpRouter'
import * as HttpServerRequest from 'effect/unstable/http/HttpServerRequest'
import * as HttpServerResponse from 'effect/unstable/http/HttpServerResponse'
import * as HttpApiBuilder from 'effect/unstable/httpapi/HttpApiBuilder'
import * as ChildProcess from 'effect/unstable/process/ChildProcess'
import * as ChildProcessSpawner from 'effect/unstable/process/ChildProcessSpawner'
import * as SqlClient from 'effect/unstable/sql/SqlClient'
import * as SqlSchema from 'effect/unstable/sql/SqlSchema'
import {
  AdminOnly,
  Authentication,
  type ClaudeMcpServer,
  CLIENT_VERSION_HEADER,
  CONFIG_STALE_HEADER,
  ConfigPull,
  CurrentDevice,
  Device,
  DeviceKind,
  DeviceNameTaken,
  Invite,
  InviteAlreadyUsed,
  InviteExpired,
  InviteUnknown,
  NotAnAdmin,
  PieApi,
  PodHasNoRecipe,
  RecipeNotFound,
  TokenMissing,
  TokenUnknown,
} from './Api.ts'
import {
  configFilePathOf,
  ConfigReferenceMissing,
  type Environment,
  HttpMcpServer,
  listDirectory,
  loadConfig,
  type McpServer,
  type ReferenceKind,
  type ToolRequest,
} from './Config.ts'

const SECRET_BYTE_LENGTH = 32

const DATABASE_FILE_NAME = 'pie.sqlite'

const MASTER_DEVICE_NAME = 'master'

const SERVER_URL_SETTING = 'server_url'

const GENERATED_NAME_BYTE_LENGTH = 3

const INVITE_LIFETIME = Duration.hours(1)

const CONFIG_CHECKOUT_DIRECTORY_NAME = 'config'

const GIT_TIMEOUT = Duration.seconds(10)

const EXECUTABLE_MODE_BITS = 0o111

const MISE_TOOLS_TABLE = '[tools]'

export class GitCommandFailed extends Schema.TaggedError<GitCommandFailed>()('GitCommandFailed', {
  gitArguments: Schema.Array(Schema.String),
  exitCode: Schema.Int,
  gitOutput: Schema.String,
}) {
  override get message(): string {
    return `git ${this.gitArguments.join(' ')} exited with ${this.exitCode}: ${this.gitOutput.trim()}`
  }
}

export class GitCommandTimedOut extends Schema.TaggedError<GitCommandTimedOut>()(
  'GitCommandTimedOut',
  { gitArguments: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `git ${this.gitArguments.join(' ')} took longer than ${Duration.format(GIT_TIMEOUT)}.`
  }
}

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

export class ConfigRepository extends Context.Service<
  ConfigRepository,
  {
    readonly checkoutDirectory: string
    readonly pull: Effect.Effect<string, GitCommandFailed | GitCommandTimedOut | PlatformError>
  }
>()('pie/ConfigRepository') {}

const createDevicesAndInvites = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE devices (
      name TEXT PRIMARY KEY,
      kind TEXT NOT NULL CHECK (kind IN ('admin', 'pod')),
      token_hash TEXT NOT NULL UNIQUE,
      recipe TEXT,
      last_up_commit TEXT,
      invited_by TEXT,
      last_seen_at INTEGER
    )
  `
  yield* sql`
    CREATE TABLE invites (
      hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('admin', 'pod')),
      recipe TEXT,
      expires_at INTEGER NOT NULL,
      redeemed_at INTEGER,
      created_by TEXT
    )
  `
})

const createSettings = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE settings (
      name TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `
})

export const generateSecret = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto
  const secretBytes = yield* crypto.randomBytes(SECRET_BYTE_LENGTH)

  return Encoding.encodeBase64Url(secretBytes)
})

export const hashSecret = Effect.fn('hashSecret')(function* (secret: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest('SHA-256', new TextEncoder().encode(secret))

  return Encoding.encodeHex(digest)
})

export const databaseLayer = (dataDirectory: string) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      yield* fileSystem.makeDirectory(dataDirectory, { recursive: true })

      return SqliteMigrator.layer({
        loader: SqliteMigrator.fromRecord({
          '1_create_devices_and_invites': createDevicesAndInvites,
          '2_create_settings': createSettings,
        }),
      }).pipe(
        Layer.provideMerge(
          SqliteClient.layer({
            filename: path.join(dataDirectory, DATABASE_FILE_NAME),
            transformResultNames: Str.snakeToCamel,
            transformQueryNames: Str.camelToSnake,
          }),
        ),
      )
    }),
  )

const countAdminDevices = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { adminCount } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ adminCount: Schema.Int }),
    execute: () => sql`SELECT count(*) AS admin_count FROM devices WHERE kind = 'admin'`,
  })(undefined)

  return adminCount
})

const insertInvite = Effect.fn('insertInvite')(function* (invite: {
  readonly deviceName: string
  readonly kind: DeviceKind
  readonly recipeName: Option.Option<string>
  readonly createdBy: Option.Option<string>
  readonly serverUrl: string
}) {
  const sql = yield* SqlClient.SqlClient
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
})

const recordServerUrl = Effect.fn('recordServerUrl')(function* (
  serverUrl: string,
  dataDirectory: string,
) {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    INSERT INTO settings (name, value) VALUES (${SERVER_URL_SETTING}, ${serverUrl})
    ON CONFLICT (name) DO UPDATE SET value = excluded.value
  `
  yield* Effect.logInfo(
    `No admin device yet. Run \`pie bootstrap --data-dir ${dataDirectory}\` on this box to get the master invite.`,
  ).pipe(Effect.when(Effect.map(countAdminDevices, (adminCount) => adminCount === 0)))
})

export const bootstrapMasterInvite = Effect.fn('bootstrapMasterInvite')(
  function* (dataDirectory: string) {
    const sql = yield* SqlClient.SqlClient
    const readServerUrl = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ value: Schema.String }),
      execute: (settingName) => sql`SELECT value FROM settings WHERE name = ${settingName}`,
    })

    yield* countAdminDevices.pipe(
      Effect.filterOrFail(
        (adminCount) => adminCount === 0,
        () => new AlreadyBootstrapped(),
      ),
    )

    const serverUrl = yield* readServerUrl(SERVER_URL_SETTING).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new ServerUrlMissing({ dataDirectory })),
          onSome: (setting) => Effect.succeed(setting.value),
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
  },
  (bootstrap) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(bootstrap)),
)

const findDeviceByTokenHash = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  return SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Device,
    execute: (tokenHash) => sql`
      SELECT name, kind, recipe, last_up_commit, invited_by, last_seen_at
      FROM devices
      WHERE token_hash = ${tokenHash}
    `,
  })
})

const authenticationLayer = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const crypto = yield* Crypto.Crypto
    const findDevice = yield* findDeviceByTokenHash

    const authenticate = Effect.fn('authenticate')(function* (credential: Redacted.Redacted) {
      const token = yield* Option.liftPredicate(Redacted.value(credential), Str.isNonEmpty).pipe(
        Option.match({ onNone: () => Effect.fail(new TokenMissing()), onSome: Effect.succeed }),
      )
      const tokenHash = yield* hashSecret(token).pipe(Effect.provideService(Crypto.Crypto, crypto))
      const device = yield* findDevice(tokenHash).pipe(
        Effect.flatMap(
          Option.match({ onNone: () => Effect.fail(new TokenUnknown()), onSome: Effect.succeed }),
        ),
      )
      const now = yield* Clock.currentTimeMillis

      yield* sql`UPDATE devices SET last_seen_at = ${now} WHERE name = ${device.name}`

      return device
    })

    return Authentication.of({
      bearer: (httpEffect, { credential }) =>
        authenticate(credential).pipe(
          Effect.catchTags({
            PlatformError: Effect.die,
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
          Effect.flatMap((device) => Effect.provideService(httpEffect, CurrentDevice, device)),
        ),
    })
  }),
)

const adminOnlyLayer = Layer.succeed(AdminOnly, (httpEffect) =>
  Effect.service(CurrentDevice).pipe(
    Effect.filterOrFail(
      (device) => device.kind === 'admin',
      (device) => new NotAnAdmin({ deviceName: device.name }),
    ),
    Effect.andThen(httpEffect),
  ),
)

const devicesHandlers = HttpApiBuilder.group(PieApi, 'devices', (handlers) =>
  handlers.handle('whoami', () => Effect.service(CurrentDevice)),
)

const podsHandlers = HttpApiBuilder.group(
  PieApi,
  'pods',
  Effect.fn(function* (handlers) {
    const sql = yield* SqlClient.SqlClient
    const listPods = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Device,
      execute: () => sql`
        SELECT name, kind, recipe, last_up_commit, invited_by, last_seen_at
        FROM devices
        WHERE kind = 'pod'
        ORDER BY name
      `,
    })

    return handlers.handle('list', () => listPods(undefined).pipe(Effect.orDie))
  }),
)

const PendingInvite = Schema.Struct({
  name: Schema.String,
  kind: DeviceKind,
  recipe: Schema.OptionFromNullOr(Schema.String),
  expiresAt: Schema.Int,
  redeemedAt: Schema.OptionFromNullOr(Schema.Int),
  createdBy: Schema.OptionFromNullOr(Schema.String),
})

const failWhenNameTaken = Effect.fn('failWhenNameTaken')(function* (deviceName: string) {
  const sql = yield* SqlClient.SqlClient
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

const redeemInvite = Effect.fn('redeemInvite')(
  function* (secret: string) {
    const sql = yield* SqlClient.SqlClient
    const now = yield* Clock.currentTimeMillis
    const inviteHash = yield* hashSecret(secret)
    const findInvite = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: PendingInvite,
      execute: (hash) => sql`
      SELECT name, kind, recipe, expires_at, redeemed_at, created_by
      FROM invites
      WHERE hash = ${hash}
    `,
    })
    const invite = yield* findInvite(inviteHash).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => Effect.fail(new InviteUnknown()), onSome: Effect.succeed }),
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

    yield* sql`INSERT INTO devices ${sql.insert({
      name: invite.name,
      kind: invite.kind,
      tokenHash,
      recipe: Option.getOrNull(invite.recipe),
      invitedBy: Option.getOrNull(invite.createdBy),
      lastSeenAt: now,
    })}`

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
  (redeem) => Effect.flatMap(SqlClient.SqlClient, (sql) => sql.withTransaction(redeem)),
)

const joinHandlers = HttpApiBuilder.group(
  PieApi,
  'join',
  Effect.fn(function* (handlers) {
    const services = yield* Effect.context<SqlClient.SqlClient | Crypto.Crypto>()

    return handlers.handle('join', ({ payload }) =>
      redeemInvite(payload.secret).pipe(
        Effect.provide(services),
        Effect.catchTags({
          NoSuchElementError: Effect.die,
          PlatformError: Effect.die,
          SchemaError: Effect.die,
          SqlError: Effect.die,
        }),
      ),
    )
  }),
)

const generateDeviceName = Effect.fn('generateDeviceName')(function* (kind: DeviceKind) {
  const crypto = yield* Crypto.Crypto
  const suffixBytes = yield* crypto.randomBytes(GENERATED_NAME_BYTE_LENGTH)

  return `${kind}-${Encoding.encodeHex(suffixBytes)}`
})

const invitesHandlers = (serverUrl: string) =>
  HttpApiBuilder.group(
    PieApi,
    'invites',
    Effect.fn(function* (handlers) {
      const services = yield* Effect.context<SqlClient.SqlClient | Crypto.Crypto>()
      const sql = yield* SqlClient.SqlClient
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const configRepository = yield* ConfigRepository
      const failWhenRecipeMissing = (recipeName: string) =>
        fileSystem
          .exists(path.join(configRepository.checkoutDirectory, 'recipes', `${recipeName}.toml`))
          .pipe(
            Effect.filterOrFail(
              (recipeExists) => recipeExists,
              () => new RecipeNotFound({ recipeName }),
            ),
          )

      return handlers.handle('create', ({ payload }) =>
        Effect.gen(function* () {
          const creator = yield* CurrentDevice
          const deviceName = yield* Option.match(payload.deviceName, {
            onNone: () => generateDeviceName(payload.kind),
            onSome: Effect.succeed,
          })

          yield* Option.match(payload.recipeName, {
            onNone: () => Effect.void,
            onSome: failWhenRecipeMissing,
          })
          yield* failWhenNameTaken(deviceName)

          return yield* insertInvite({
            deviceName,
            kind: payload.kind,
            recipeName: payload.recipeName,
            createdBy: Option.some(creator.name),
            serverUrl,
          })
        }).pipe(
          sql.withTransaction,
          Effect.provide(services),
          Effect.catchTags({
            NoSuchElementError: Effect.die,
            PlatformError: Effect.die,
            SchemaError: Effect.die,
            SqlError: Effect.die,
          }),
        ),
      )
    }),
  )

const tomlInlineTableOf = (toolRequest: ToolRequest) =>
  `{ ${Arr.map(
    Record.toEntries(toolRequest),
    ([optionName, optionValue]) => `${JSON.stringify(optionName)} = ${JSON.stringify(optionValue)}`,
  ).join(', ')} }`

const miseConfigOf = (environment: Environment) =>
  [
    MISE_TOOLS_TABLE,
    ...Arr.map(
      Record.toEntries(environment.tools),
      ([toolName, toolRequest]) =>
        `${JSON.stringify(toolName)} = ${tomlInlineTableOf(toolRequest)}`,
    ),
    '',
  ].join('\n')

const isHttpMcpServer = Schema.is(HttpMcpServer)

const claudeMcpServerOf = (mcpServer: McpServer): ClaudeMcpServer =>
  isHttpMcpServer(mcpServer)
    ? { type: 'http', url: mcpServer.url }
    : { type: 'stdio', command: mcpServer.command, args: mcpServer.args }

const lookUpRecipeReference = <Value>(
  recipeName: string,
  referenceKind: ReferenceKind,
  entries: Record.ReadonlyRecord<string, Value>,
  referenceName: string,
): Effect.Effect<Value, ConfigReferenceMissing> =>
  Option.match(Record.get(entries, referenceName), {
    onNone: () =>
      Effect.fail(
        new ConfigReferenceMissing({
          filePath: configFilePathOf.recipe(recipeName),
          referenceKind,
          referenceName,
        }),
      ),
    onSome: Effect.succeed,
  })

const readPodFile = Effect.fn('readPodFile')(function* (
  configDirectory: string,
  filePath: string,
  podPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absoluteFilePath = path.join(configDirectory, filePath)
  const content = yield* fileSystem.readFile(absoluteFilePath)
  const fileInfo = yield* fileSystem.stat(absoluteFilePath)

  return { path: podPath, content, executable: (fileInfo.mode & EXECUTABLE_MODE_BITS) !== 0 }
})

const readRepositoryFile = (configDirectory: string, filePath: string) =>
  readPodFile(configDirectory, filePath, filePath)

const readSkillFiles = Effect.fn('readSkillFiles')(function* (
  configDirectory: string,
  skillName: string,
) {
  const path = yield* Path.Path
  const skillDirectory = path.dirname(configFilePathOf.skill(skillName))
  const skillFilePaths = yield* listDirectory(configDirectory, skillDirectory, 'File', {
    recursive: true,
  })

  return yield* Effect.forEach(skillFilePaths, (skillFilePath) =>
    readRepositoryFile(configDirectory, path.join(skillDirectory, skillFilePath)),
  )
})

const podConfigOf = Effect.fn('podConfigOf')(function* (
  configDirectory: string,
  recipeName: string,
  commit: string,
) {
  const config = yield* loadConfig(configDirectory)
  const recipe = yield* Option.match(Record.get(config.recipes, recipeName), {
    onNone: () => Effect.fail(new RecipeNotFound({ recipeName })),
    onSome: Effect.succeed,
  })
  const environment = yield* lookUpRecipeReference(
    recipeName,
    'environment',
    config.environments,
    recipe.environment,
  )
  const mcpServerEntries = yield* Effect.forEach(recipe.mcp, (mcpName) =>
    lookUpRecipeReference(recipeName, 'mcp', config.mcpServers, mcpName).pipe(
      Effect.map((mcpServer) => [mcpName, claudeMcpServerOf(mcpServer)] as const),
    ),
  )
  const agentFiles = yield* Effect.forEach(recipe.agents, (agentName) =>
    readRepositoryFile(configDirectory, configFilePathOf.agent(agentName)),
  )
  const skillFiles = yield* Effect.forEach(recipe.skills, (skillName) =>
    readSkillFiles(configDirectory, skillName),
  )
  const tasks = yield* Effect.forEach(environment.tasks, (taskName) =>
    readPodFile(configDirectory, configFilePathOf.task(taskName), taskName),
  )

  return {
    commit,
    miseConfig: miseConfigOf(environment),
    tasks,
    repositories: recipe.repositories,
    claudeFiles: [...agentFiles, ...Arr.flatten(skillFiles)],
    mcpServers: Record.fromEntries(mcpServerEntries),
  }
})

const podHandlers = HttpApiBuilder.group(
  PieApi,
  'pod',
  Effect.fn(function* (handlers) {
    const services = yield* Effect.context<
      FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
    >()
    const sql = yield* SqlClient.SqlClient
    const configRepository = yield* ConfigRepository

    return handlers
      .handle('config', () =>
        Effect.gen(function* () {
          const device = yield* CurrentDevice
          const recipeName = yield* Option.match(device.recipe, {
            onNone: () => Effect.fail(new PodHasNoRecipe({ deviceName: device.name })),
            onSome: Effect.succeed,
          })
          const commit = yield* runGit([
            '-C',
            configRepository.checkoutDirectory,
            'rev-parse',
            'HEAD',
          ])

          return yield* podConfigOf(configRepository.checkoutDirectory, recipeName, commit.trim())
        }).pipe(
          Effect.provide(services),
          Effect.catchTags({
            GitCommandFailed: Effect.die,
            GitCommandTimedOut: Effect.die,
            PlatformError: Effect.die,
          }),
        ),
      )
      .handle('up', ({ payload }) =>
        Effect.gen(function* () {
          const device = yield* CurrentDevice

          yield* sql`UPDATE devices SET last_up_commit = ${payload.commit} WHERE name = ${device.name}`
        }).pipe(Effect.catchTags({ SqlError: Effect.die })),
      )
  }),
)

export const runGit = Effect.fn('runGit')(
  function* (gitArguments: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const gitProcess = yield* spawner.spawn(
      ChildProcess.make('git', gitArguments, {
        extendEnv: true,
        env: { GIT_TERMINAL_PROMPT: '0' },
      }),
    )
    const [gitOutput, exitCode] = yield* Effect.all(
      [Stream.mkString(Stream.decodeText(gitProcess.all)), gitProcess.exitCode],
      { concurrency: 'unbounded' },
    )

    if (exitCode === 0) {
      return gitOutput
    }

    return yield* new GitCommandFailed({ gitArguments, exitCode, gitOutput })
  },
  Effect.scoped,
  (gitCommand, gitArguments) =>
    Effect.timeoutOrElse(gitCommand, {
      duration: GIT_TIMEOUT,
      orElse: () => Effect.fail(new GitCommandTimedOut({ gitArguments })),
    }),
)

const configRepositoryLayer = (dataDirectory: string, configRepositoryUrl: string) =>
  Layer.effect(
    ConfigRepository,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const checkoutDirectory = path.join(dataDirectory, CONFIG_CHECKOUT_DIRECTORY_NAME)
      const alreadyCloned = yield* fileSystem.exists(path.join(checkoutDirectory, '.git'))
      const pullPermit = yield* Semaphore.make(1)

      yield* runGit(['clone', '--quiet', configRepositoryUrl, checkoutDirectory]).pipe(
        Effect.when(Effect.succeed(!alreadyCloned)),
      )

      return ConfigRepository.of({
        checkoutDirectory,
        pull: runGit(['-C', checkoutDirectory, 'pull', '--ff-only', '--quiet']).pipe(
          Semaphore.withPermits(pullPermit, 1),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
      })
    }),
  )

const configPullLayer = Layer.effect(
  ConfigPull,
  Effect.gen(function* () {
    const configRepository = yield* ConfigRepository
    const serveLastPull = (pullError: GitCommandFailed | GitCommandTimedOut | PlatformError) =>
      Effect.logWarning(`Serving the last config pull. ${pullError.message}`).pipe(
        Effect.as(HttpServerResponse.setHeader(CONFIG_STALE_HEADER, 'true')),
      )

    return ConfigPull.of((httpEffect) =>
      configRepository.pull.pipe(
        Effect.as(identity<HttpServerResponse.HttpServerResponse>),
        Effect.catchTags({
          GitCommandFailed: serveLastPull,
          GitCommandTimedOut: serveLastPull,
          PlatformError: serveLastPull,
        }),
        Effect.flatMap((markResponse) => Effect.map(httpEffect, markResponse)),
      ),
    )
  }),
)

export const apiLayer = (settings: {
  readonly dataDirectory: string
  readonly configRepositoryUrl: string
  readonly serverUrl: string
}) => {
  const { dataDirectory, configRepositoryUrl, serverUrl } = settings
  const databaseAndMiddleware = Layer.mergeAll(
    authenticationLayer,
    adminOnlyLayer,
    configPullLayer,
    Layer.effectDiscard(recordServerUrl(serverUrl, dataDirectory)),
  ).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        databaseLayer(dataDirectory),
        configRepositoryLayer(dataDirectory, configRepositoryUrl),
      ),
    ),
  )
  const handlers = Layer.mergeAll(
    joinHandlers,
    devicesHandlers,
    podsHandlers,
    invitesHandlers(serverUrl),
    podHandlers,
  ).pipe(Layer.provide(databaseAndMiddleware))

  return HttpApiBuilder.layer(PieApi).pipe(Layer.provide(handlers))
}

const logRequestWithClientVersion = <Failure, Requirements>(
  httpApp: Effect.Effect<HttpServerResponse.HttpServerResponse, Failure, Requirements>,
) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest
    const clientVersion = Headers.get(request.headers, CLIENT_VERSION_HEADER).pipe(
      Option.getOrElse(() => 'unknown'),
    )

    return yield* HttpMiddleware.logger(httpApp).pipe(
      Effect.annotateLogs('client.version', clientVersion),
    )
  })

export const serveLayer = (settings: {
  readonly host: string
  readonly port: number
  readonly dataDirectory: string
  readonly configRepositoryUrl: string
  readonly serverUrl: string
}) =>
  HttpRouter.serve(apiLayer(settings), {
    disableLogger: true,
    middleware: logRequestWithClientVersion,
  }).pipe(Layer.provide(BunHttpServer.layer({ hostname: settings.host, port: settings.port })))
