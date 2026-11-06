# In-memory servers

Run a real server pipeline without a port, and call it through its typed client. Both work under `bun:test` and vitest.

## `HttpApiTest`

```ts
import * as HttpServer from "effect/http/HttpServer"
import * as HttpApiTest from "effect/http-api/HttpApiTest"

const HandlersOverMemoryUsers = UsersApiHandlers.pipe(Layer.provide(Users.layerMemory))
const HandlersUnderTest = HandlersOverMemoryUsers.pipe(Layer.provideMerge(AuthorizationLayer))
const TestLayer = Layer.mergeAll(HandlersUnderTest, HttpServer.layerServices, AuthorizationClient)

const program = Effect.gen(function*() {
  const client = yield* HttpApiTest.groups(Api, ["users"])
  const created = yield* client.users.create({ payload: { name: "Alice" } })
  const found = yield* client.users.getById({ params: { id: created.id } })
  const missing = yield* client.users.getById({ params: { id: 999 } }).pipe(
    Effect.catchTag("UserNotFound", () => Effect.succeed(undefined))
  )
  return { found, missing }
}).pipe(Effect.scoped, Effect.provide(TestLayer))
```

- It runs routing, decoding, middleware, encoding and client error decoding: the `catchTag` above catches a real 404.
- It needs a `Scope`. Groups you don't select get placeholder handlers that die.
- A `requiredForClient` middleware needs its client layer too (`AuthorizationClient` above).
- No server starts, so real sockets and client aborts aren't emulated.

## `McpTest.makeClient`

```ts
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as McpTest from "effect/ai/McpTest"
import * as Toolkit from "effect/ai/Toolkit"

const Greeting = McpServer.resource({
  uri: "test://greeting",
  name: "greeting",
  content: Effect.succeed("hello")
})
const Tools = Toolkit.make(Echo)
const ToolsLayer = McpServer.toolkit(Tools).pipe(
  Layer.provide(Tools.toLayer({ Echo: ({ text }) => Effect.succeed(text) }))
)

const program = Effect.gen(function*() {
  const client = yield* McpTest.makeClient(Layer.mergeAll(Greeting, ToolsLayer), {
    protocols: [McpProtocol.v2025_11_25]
  })
  const resource = yield* client.readResource({ uri: "test://greeting" })
  const echoed = yield* client.callTool({ name: "Echo", arguments: { text: "hi" } })
  return { resource, echoed }
}).pipe(Effect.scoped)
```

The client also has `listTools`, `listResources`, `listPrompts`, `getPrompt`, `complete`, `subscribe` and `ping`.

For RPC, see `RpcTest.makeClient` in `../networking/rpc.md`. For a CLI, see `Command.runWith` in `../cli/cli.md`.
