# HttpApi

`effect/http-api`. Builders chain `.add(...)`: endpoints → group, groups → api.

Endpoint option keys: `params` (path `:name`), `query`, `headers`, `payload` (body for POST/PUT; **query for GET**), `success` (default no content; array = content-type negotiation), `error` (one schema or array).

DO keep API definition in its own package/files, separate from server impl, so clients import it cleanly.
DO use `transformClient` (not call-site) for client base-url + retry; provide `requiredForClient` middleware impls.
DO `HttpApiBuilder.layer(Api, { openapiPath })` — it only takes `openapiPath`; put title/version in `OpenApi.annotations`.
DON'T hand-build fetch calls against an HttpApi — use the generated client for end-to-end type safety.
DON'T forget GET `payload` maps to the query string while POST `payload` maps to the body.

## Define API

```ts
import * as Schema from "effect/Schema"
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint"
import * as HttpApiError from "effect/http-api/HttpApiError"
import * as HttpApiGroup from "effect/http-api/HttpApiGroup"
import * as HttpApiSchema from "effect/http-api/HttpApiSchema"
import * as OpenApi from "effect/http-api/OpenApi"

export class UsersApiGroup extends HttpApiGroup.make("users")
  .add(
    HttpApiEndpoint.get("list", "/", {
      query: { search: Schema.optional(Schema.String) },
      success: Schema.Array(User)
    }),
    HttpApiEndpoint.get("getById", "/:id", {
      params: { id: Schema.FiniteFromString.pipe(Schema.decodeTo(UserId)) },
      success: User,
      error: UserNotFound.pipe(HttpApiSchema.asNoContent({ decode: () => new UserNotFound() }))
    }),
    HttpApiEndpoint.post("create", "/", {
      payload: Schema.Struct({ name: Schema.String, email: Schema.String }),
      success: User
    }),
    HttpApiEndpoint.get("search", "/search", {
      payload: { search: Schema.String },
      success: [Schema.Array(User), Schema.String.pipe(HttpApiSchema.asText({ contentType: "text/csv" }))],
      error: [SearchQueryTooShort.pipe(HttpApiSchema.asNoContent({ decode: () => new SearchQueryTooShort() })),
              HttpApiError.RequestTimeoutNoContent]
    })
  )
  .middleware(Authorization)
  .prefix("/users")
  .annotateMerge(OpenApi.annotations({ title: "Users", description: "..." }))
{}

export class Api extends HttpApi.make("user-api")
  .add(UsersApiGroup).add(SystemApi)
  .annotateMerge(OpenApi.annotations({ title: "Acme User API" }))
{}
```

## Error status — two equivalent forms

```ts
export class UserNotFound extends Schema.TaggedError<UserNotFound>()(
  "UserNotFound", {}, { httpApiStatus: 404 }
) {}

error: UserNotFound.pipe(HttpApiSchema.status(404))
```

`HttpApiSchema`: `.status(n)`, `.asNoContent({ decode })`, `.asText({ contentType })`.

## Handlers — `HttpApiBuilder.group(Api, name, build)`

```ts
import * as Effect from "effect/Effect"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"

export const UsersApiHandlers = HttpApiBuilder.group(
  Api, "users",
  Effect.fn("UsersApiHandlers")(function*(handlers) {
    const users = yield* Users
    return handlers
      .handle("list", ({ query }) => users.list(query.search).pipe(Effect.orDie))
      .handle("getById", ({ params }) =>
        users.getById(params.id).pipe(
          Effect.catchReasons("UsersError", { UserNotFound: (e) => Effect.fail(e) }, Effect.die)
        ))
      .handle("me", () => CurrentUser)
  })
)
```

The group's layer stays open, like a service's. The edge wires it, so a test can give it fakes:

```ts
const UsersApiLayer = UsersApiHandlers.pipe(Layer.provide(Layer.mergeAll(Users.layer, AuthorizationLayer)))
```

Handler ctx object exposes decoded `payload`, `params`, `query`, `headers`, plus `request`, `endpoint`, `group`.

## Long handlers in their own files

Declare the endpoint as a constant so the handler can derive its input from it, rather than restating the schema:

```ts
export const Create = HttpApiEndpoint.post("create", "/", {
  payload: Schema.Struct({ name: Schema.String }),
  success: User
})

export const createUser = Effect.fn("UsersApi.create")(function*(
  { payload }: Pick<HttpApiEndpoint.Request<typeof Create>, "payload">
) {
  const users = yield* Users
  return yield* users.create(payload)
})

// handlers.handle("create", createUser)
```

- DO `Pick` the fields you use. The whole `HttpApiEndpoint.Request<typeof Create>` carries `endpoint`, typed without what the group adds, so it fails with `TS2345` once the group has a `.prefix` or `.middleware`.
- For the whole request, `HttpApiEndpoint.Request<HttpApiEndpoint.WithIdentifier<HttpApiGroup.Endpoints<typeof UsersApiGroup>, "create">>` includes them.
- `HttpApiBuilder.handler(Api, "users", "create", Effect.fn("UsersApi.create")(function*({ payload }) { ... }))` infers the input, but the handler's file then imports the whole `Api`.

## Middleware — `HttpApiMiddleware.Service`

```ts
export class Authorization extends HttpApiMiddleware.Service<Authorization, {
  provides: CurrentUser
  requires: never
}>()("acme/HttpApi/Authorization", {
  requiredForClient: true,
  security: { bearer: HttpApiSecurity.bearer },
  error: Unauthorized
}) {}
```

A middleware without `security` is one function: `Layer.succeed(RequestLogger, (effect) => Effect.tap(effect, ...))`.
With `security` it's one function per scheme: `Layer.succeed(Authorization, { bearer: (effect, { credential }) => Effect.provideService(effect, CurrentUser, user) })`. Keep each an arrow: `Effect.fn` in that position loses the contextual types (`TS2322`).
`HttpApiSecurity`: `.bearer`, `.basic`, `.apiKey({ in: "header"|"query"|"cookie", key })`, `.http({ scheme })`.

## Serve + derive client

```ts
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as HttpRouter from "effect/http/HttpRouter"
import * as HttpServer from "effect/http/HttpServer"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientRequest from "effect/http/HttpClientRequest"
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder"
import * as HttpApiClient from "effect/http-api/HttpApiClient"
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware"
import * as HttpApiScalar from "effect/http-api/HttpApiScalar"
import { createServer } from "node:http"

const ApiRoutes = HttpApiBuilder.layer(Api, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide([UsersApiLayer, SystemApiLayer])
)
const DocsRoute = HttpApiScalar.layer(Api, { path: "/docs" })

const HttpServerLayer = HttpRouter.serve(Layer.mergeAll(ApiRoutes, DocsRoute)).pipe(
  Layer.provide(NodeHttpServer.layer(createServer, { port: 3000 }))
)
Layer.launch(HttpServerLayer).pipe(NodeRuntime.runMain)

// serverless: HttpRouter.toWebHandler(routes.pipe(Layer.provide(HttpServer.layerServices)))

const AuthorizationClient = HttpApiMiddleware.layerClient(Authorization,
  Effect.fn("AuthorizationClient")(function*({ next, request }) {
    return yield* next(HttpClientRequest.bearerToken(request, "dev-token"))
  }))

class ApiClient extends Context.Service<ApiClient, HttpApiClient.ForApi<typeof Api>>()("acme/ApiClient") {
  static readonly layer = Layer.effect(ApiClient,
    HttpApiClient.make(Api, {
      transformClient: (client) => client.pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl("http://localhost:3000")),
        HttpClient.retryTransient({ schedule: Schedule.exponential(100), times: 3 })
      )
    })
  )
}

const ApiClientLayer = ApiClient.layer.pipe(Layer.provide(Layer.mergeAll(AuthorizationClient, FetchHttpClient.layer)))
// usage: const client = yield* ApiClient; yield* client.users.list();
//        yield* client.users.getById({ params: { id: 123 } })
```

For tests, `HttpApiTest` runs the API with no port: see `../testing/in-memory-servers.md`.
