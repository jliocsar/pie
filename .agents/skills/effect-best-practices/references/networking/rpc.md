# RPC

`effect/unstable/rpc`.

- `Rpc.make(tag, { payload?, success?, error?, defect?, stream?, primaryKey? })`. Defaults: success `Schema.Void`, error `Schema.Never`. `payload` accepts a `Schema.Struct` field map or a Schema. `stream: true` → streaming RPC (`RpcSchema.Stream`); `primaryKey` derives a payload class key.
- `RpcGroup.make(...rpcs)` is **variadic, takes NO name string**. Returns a group with `.toLayer(handlers)`, `.toHandlers`, `.toLayerHandler(tag, ...)`, `.of(handlers)`, `.accessHandler(tag)`, `.annotate/.annotateRpcs/.annotateMerge`.

DON'T pass a group name to `RpcGroup.make` and DON'T use `failure:` — both are docs-v4 mdx bugs. The real error key is `error:`.

## Define + group + handlers

```ts
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Rpc from "effect/unstable/rpc/Rpc"
import * as RpcGroup from "effect/unstable/rpc/RpcGroup"

class User extends Schema.Class<User>("User")({ id: Schema.Number, name: Schema.String }) {}
class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", { userId: Schema.Number }) {}

export const GetUser = Rpc.make("GetUser", { payload: { id: Schema.Number }, success: User, error: UserNotFound })
export const ListUsers = Rpc.make("ListUsers", { success: Schema.Array(User) })

export class UsersRpc extends RpcGroup.make(GetUser, ListUsers) {}

export const UsersHandlers = UsersRpc.toLayer({
  GetUser: (payload) => Effect.gen(function*() {
    if (payload.id === 1) return new User({ id: 1, name: "Alice" })
    return yield* new UserNotFound({ userId: payload.id })
  }),
  ListUsers: () => Effect.succeed([new User({ id: 1, name: "Alice" })])
})
```

Handler receives `(payload, { client, requestId, headers, rpc })` — the decoded payload itself, not a `{ payload }` wrapper. Raise errors by returning/`yield*`ing a `Schema.TaggedError`. `Rpc.fork` opts a handler out of sequential execution (run concurrently).

## Server / client wiring

- Server: `RpcServer.layer(group)` + a protocol layer. Over HTTP: `RpcServer.layerHttp({ group, path, ... })` or `RpcServer.layerProtocolHttp(...)`. Also `layerProtocolWebsocket`, `layerProtocolSocketServer`, `layerProtocolStdio`, `layerProtocolWorkerRunner`.
- Client: `RpcClient.make(group, { flatten? })` + a protocol: `RpcClient.layerProtocolHttp({ url, transformClient? })`, `layerProtocolSocket(...)`, `layerProtocolWorker(...)`. HTTP = one request per call; socket/worker keep a live channel for streaming/acks/interruption.
- Serialization layer required by protocols: `RpcSerialization.layerJson` / `layerNdjson` (sockets/workers need framing) / `layerMsgPack` / `layerJsonRpc` / `layerNdJsonRpc`.
- Testing: `RpcTest` for in-memory handler testing.
- Middleware: `RpcMiddleware`.

DO `RpcGroup.make(rpcA, rpcB, ...)` then `.toLayer({ TagA: handler, ... })`.
DO pick serialization matching transport — `layerNdjson`/`layerMsgPack` for sockets/workers, `layerJson` for HTTP.
