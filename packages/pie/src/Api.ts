import * as Context from 'effect/Context'
import * as DateTime from 'effect/DateTime'
import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/unstable/httpapi/HttpApiMiddleware'
import * as HttpApiSecurity from 'effect/unstable/httpapi/HttpApiSecurity'
import {
  ConfigFileInvalid,
  ConfigFileUnparseable,
  ConfigNameMismatch,
  ConfigReferenceMissing,
  FrontmatterMissing,
  McpAuthNotSupportedYet,
} from './Config.ts'

export const CLIENT_VERSION_HEADER = 'pie-client-version'

export const CONFIG_STALE_HEADER = 'pie-config-stale'

export const DeviceName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/u, {
    message:
      'A device name is lowercase letters, digits and dashes, starting with a letter or digit.',
  }),
)

export const RecipeName = Schema.String.check(
  Schema.isPattern(/^[\w-]+$/u, {
    message: 'A recipe name is the file name under recipes/, without .toml.',
  }),
)

export const InvitePayload = Schema.Struct({
  serverUrl: Schema.String,
  secret: Schema.String,
})

export type InvitePayload = typeof InvitePayload.Type

export const Invite = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(InvitePayload)),
)

export const DeviceKind = Schema.Literals(['admin', 'pod'])

export type DeviceKind = typeof DeviceKind.Type

export const Device = Schema.Struct({
  name: Schema.String,
  kind: DeviceKind,
  recipe: Schema.OptionFromNullOr(Schema.String),
  lastUpCommit: Schema.OptionFromNullOr(Schema.String),
  invitedBy: Schema.OptionFromNullOr(Schema.String),
  lastSeenAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromMillis),
})

export type Device = typeof Device.Type

export class TokenMissing extends Schema.TaggedError<TokenMissing>()(
  'TokenMissing',
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return 'This request carries no pie token. Run `pie login <invite>` first.'
  }
}

export class TokenUnknown extends Schema.TaggedError<TokenUnknown>()(
  'TokenUnknown',
  {},
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "pie doesn't know this token: it was revoked, or never issued. Log in again with a fresh invite."
  }
}

export class NotAnAdmin extends Schema.TaggedError<NotAnAdmin>()(
  'NotAnAdmin',
  { deviceName: Schema.String },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `${this.deviceName} is a pod, and only admin devices can do this.`
  }
}

export class InviteUnknown extends Schema.TaggedError<InviteUnknown>()(
  'InviteUnknown',
  {},
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "pie doesn't know this invite. Ask for a fresh one with `pie invite new`."
  }
}

export class InviteAlreadyUsed extends Schema.TaggedError<InviteAlreadyUsed>()(
  'InviteAlreadyUsed',
  { deviceName: Schema.String },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return `This invite was already used by ${this.deviceName}. Ask for a fresh one with \`pie invite new\`.`
  }
}

export class InviteExpired extends Schema.TaggedError<InviteExpired>()(
  'InviteExpired',
  { deviceName: Schema.String, expiredAt: Schema.DateTimeUtcFromMillis },
  { httpApiStatus: 410 },
) {
  override get message(): string {
    return `This invite for ${this.deviceName} expired at ${DateTime.formatIso(this.expiredAt)}. Ask for a fresh one with \`pie invite new\`.`
  }
}

export class DeviceNameTaken extends Schema.TaggedError<DeviceNameTaken>()(
  'DeviceNameTaken',
  { deviceName: Schema.String },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `pie already has a device or a pending invite named ${this.deviceName}. Pick another --name.`
  }
}

export class RecipeNotFound extends Schema.TaggedError<RecipeNotFound>()(
  'RecipeNotFound',
  { recipeName: Schema.String },
  { httpApiStatus: 422 },
) {
  override get message(): string {
    return `The config repo has no recipes/${this.recipeName}.toml at its latest pull.`
  }
}

export class PodHasNoRecipe extends Schema.TaggedError<PodHasNoRecipe>()(
  'PodHasNoRecipe',
  { deviceName: Schema.String },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return `${this.deviceName} has no recipe yet, so there's nothing to apply.`
  }
}

export class CurrentDevice extends Context.Service<CurrentDevice, Device>()('pie/CurrentDevice') {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentDevice }
>()('pie/Authentication', {
  security: { bearer: HttpApiSecurity.bearer },
  error: [TokenMissing, TokenUnknown],
}) {}

export class AdminOnly extends HttpApiMiddleware.Service<AdminOnly, { requires: CurrentDevice }>()(
  'pie/AdminOnly',
  { error: NotAnAdmin },
) {}

export class ConfigPull extends HttpApiMiddleware.Service<ConfigPull>()('pie/ConfigPull') {}

export const Joined = Schema.Struct({ token: Schema.String, device: Device })

export const NewInvite = Schema.Struct({
  deviceName: Schema.OptionFromNullOr(DeviceName),
  recipeName: Schema.OptionFromNullOr(RecipeName),
  kind: DeviceKind,
})

export const CreatedInvite = Schema.Struct({
  invite: Schema.String,
  deviceName: Schema.String,
  kind: DeviceKind,
  expiresAt: Schema.DateTimeUtcFromMillis,
})

export const PodFile = Schema.Struct({
  path: Schema.String,
  content: Schema.Uint8ArrayFromBase64,
  executable: Schema.Boolean,
})

export type PodFile = typeof PodFile.Type

export const ClaudeMcpServer = Schema.Union([
  Schema.Struct({ type: Schema.Literal('http'), url: Schema.String }),
  Schema.Struct({
    type: Schema.Literal('stdio'),
    command: Schema.String,
    args: Schema.Array(Schema.String),
  }),
])

export type ClaudeMcpServer = typeof ClaudeMcpServer.Type

export const PodRepository = Schema.Struct({ repo: Schema.String, dir: Schema.String })

export type PodRepository = typeof PodRepository.Type

export const PodConfig = Schema.Struct({
  commit: Schema.String,
  miseConfig: Schema.String,
  tasks: Schema.Array(PodFile),
  repositories: Schema.Array(PodRepository),
  claudeFiles: Schema.Array(PodFile),
  mcpServers: Schema.Record(Schema.String, ClaudeMcpServer),
})

export type PodConfig = typeof PodConfig.Type

export class JoinGroup extends HttpApiGroup.make('join').add(
  HttpApiEndpoint.post('join', '/join', {
    payload: Schema.Struct({ secret: Schema.String }),
    success: Joined,
    error: [InviteUnknown, InviteAlreadyUsed, InviteExpired, DeviceNameTaken],
  }),
) {}

export class DevicesGroup extends HttpApiGroup.make('devices')
  .add(HttpApiEndpoint.get('whoami', '/whoami', { success: Device }))
  .middleware(Authentication) {}

export class PodsGroup extends HttpApiGroup.make('pods')
  .add(HttpApiEndpoint.get('list', '/pods', { success: Schema.Array(Device) }))
  .middleware(AdminOnly)
  .middleware(Authentication) {}

export class InvitesGroup extends HttpApiGroup.make('invites')
  .add(
    HttpApiEndpoint.post('create', '/invites', {
      payload: NewInvite,
      success: CreatedInvite,
      error: [DeviceNameTaken, RecipeNotFound],
    }),
  )
  .middleware(ConfigPull)
  .middleware(AdminOnly)
  .middleware(Authentication) {}

export class PodGroup extends HttpApiGroup.make('pod')
  .add(
    HttpApiEndpoint.get('config', '/pod/config', {
      success: PodConfig,
      error: [
        PodHasNoRecipe,
        RecipeNotFound,
        ConfigFileUnparseable,
        FrontmatterMissing,
        ConfigFileInvalid,
        ConfigNameMismatch,
        ConfigReferenceMissing,
        McpAuthNotSupportedYet,
      ],
    }).middleware(ConfigPull),
  )
  .add(
    HttpApiEndpoint.post('up', '/pod/up', {
      payload: Schema.Struct({ commit: Schema.String }),
    }),
  )
  .middleware(Authentication) {}

export class PieApi extends HttpApi.make('pie')
  .add(JoinGroup)
  .add(DevicesGroup)
  .add(PodsGroup)
  .add(InvitesGroup)
  .add(PodGroup) {}
