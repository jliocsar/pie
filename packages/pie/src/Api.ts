import * as Context from 'effect/Context'
import * as Schema from 'effect/Schema'
import * as HttpApi from 'effect/unstable/httpapi/HttpApi'
import * as HttpApiEndpoint from 'effect/unstable/httpapi/HttpApiEndpoint'
import * as HttpApiGroup from 'effect/unstable/httpapi/HttpApiGroup'
import * as HttpApiMiddleware from 'effect/unstable/httpapi/HttpApiMiddleware'
import * as HttpApiSecurity from 'effect/unstable/httpapi/HttpApiSecurity'

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

export class CurrentDevice extends Context.Service<CurrentDevice, Device>()('pie/CurrentDevice') {}

export class Authentication extends HttpApiMiddleware.Service<
  Authentication,
  { provides: CurrentDevice }
>()('pie/Authentication', {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: [TokenMissing, TokenUnknown],
}) {}

export class AdminOnly extends HttpApiMiddleware.Service<AdminOnly, { requires: CurrentDevice }>()(
  'pie/AdminOnly',
  { error: NotAnAdmin },
) {}

export class DevicesGroup extends HttpApiGroup.make('devices')
  .add(HttpApiEndpoint.get('whoami', '/whoami', { success: Device }))
  .middleware(Authentication) {}

export class PodsGroup extends HttpApiGroup.make('pods')
  .add(HttpApiEndpoint.get('list', '/pods', { success: Schema.Array(Device) }))
  .middleware(AdminOnly)
  .middleware(Authentication) {}

export class PieApi extends HttpApi.make('pie').add(DevicesGroup).add(PodsGroup) {}
