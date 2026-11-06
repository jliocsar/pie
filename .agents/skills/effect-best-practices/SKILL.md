---
name: effect-best-practices
description: Effect v4 patterns for effects, services, layers, schema, errors, concurrency, observability, CLIs, SQL, AI, atoms, and testing. Use when writing or reviewing TypeScript code that uses Effect (the `effect` package or `@effect/*`).
---

# Effect v4 Best Practices

Opinionated, verified patterns for Effect v4 (`effect@4.x` and `@effect/*`). Optimized for type safety, testability, observability, and tracing. All rules are verified against the source of Effect 4.1.2 — they differ substantially from Effect v3.

When this skill and the source disagree, the source wins. Say so when it happens: the disagreement is a bug in this skill.

Supported packages: `effect`, `@effect/atom-react`, `@effect/opentelemetry`, `@effect/platform-bun`, `@effect/sql-*`, `@effect/ai-*`, `@effect/vitest`.

## How to use this skill

Start at `references/index.md` and navigate to the relevant pillar. Each folder's `index.md` lists its files. Consult the specific reference before writing non-trivial code in that area — the v4 APIs are easy to get wrong from memory.

## Critical rules (apply always)

| Topic | DO | DON'T |
| --- | --- | --- |
| Imports | leaf modules: `effect/Effect`, `effect/cli/Command` | barrels: `from "effect"`, `effect/testing`, `effect/http` |
| Authoring | `Effect.gen` + `Effect.fn("name")`, attach combinators via `.pipe` | functions returning `Effect.gen`; `.pipe` on `Effect.fn` |
| Failing in gen | `return yield* new SomeError(...)` | bare `yield*` of an error mid-block |
| Services | `Context.Service<X>()("id", { make })` + hand-written `static layer` | `Effect.Service` (gone); assuming `.Default` |
| Deps | resolve via `yield*` inside `make`, platform services and `Config` included, so methods carry no requirements | `Service.use` everywhere; `yield* FileSystem.FileSystem` in free functions |
| Layers | `static readonly layer = Layer.effect(this, this.make)`, deps left open; wire once at the edge with `mergeAll` (independent), `provide` (hide dep), `provideMerge` (expose), one named stage per `provide` | `Layer.provide` inside a service's own `layer`; deep `Layer.provide` chains |
| Versions | pin every Effect package exactly, all to one version | a caret on `effect` or `@effect/*`: `@stability unstable` modules, `cli/Command` and `http/HttpClient` among them, can break in minor releases |
| Testing | build the real service from its open `layer` over fakes: `Layer.succeed`, `Layer.mock`, `HttpClient.make`, `ChildProcessSpawner.make`, `TestConsole.layer`; `HttpApiTest`, `McpTest.makeClient` and `Command.runWith` run servers and CLIs in memory | fake binaries on disk, a patched `fetch`, env vars that exist only for tests |
| Errors | `Schema.TaggedError<Self>()("Tag", {...})`, one per failure reason | `Schema.TaggedErrorClass` (not in 4.1.2); generic shared errors |
| Catch | `Effect.catch` / `catchTag` / `catchTags` / `catchCause` | `catchAll` / `catchSome` (renamed) |
| Tags | `catchTag` / `catchReason` / `Match.tagsExhaustive` / `Union.match`; `Union.guards.X(value)` for one variant | reading `x._tag` or `error.reason._tag`: it keeps compiling when a variant is added, so the new case goes unhandled; `Predicate.isTagged`: it takes `unknown`, so a typo compiles |
| Result type | `Result`; `yield*` it inside `Result.gen`, and lift it with `Effect.fromResult` inside `Effect.gen`, as `Effect.fromOption` does for an `Option` | `Either` (gone); `yield*` of a `Result` or `Option` in `Effect.gen`: a type error, and it dies at runtime |
| Schema filters | `.check(Schema.isMinLength(n))` | `Schema.minLength(n)` (gone) |
| IDs / domain | brand ids (`Schema.brand`); `Option<T>` for absence | plain `string` ids; `null`/`undefined` |
| Concurrency | option-driven `{ concurrency }`; `Semaphore.make(n)` | `*Par` variants (gone) |
| Running | `runMain` at entrypoint; `ManagedRuntime` at framework edge | scattered `run*`; `runSync` on async |
| Logging | `Effect.log*` + `annotateLogs` | `console.log` |
| Metrics | standalone `Metric.update(m, v)` | `m.increment()`; `Effect.withMetric` |
| Config | `Config.*` + `ConfigProvider`; `Config.Redacted` for secrets | `process.env` directly |
| Boundaries | decode CLI args, env and files with Schema where they enter; brand ids | re-validating or re-reading downstream |
| Tracing | `Effect.fn("Service.method")` (auto-span) + `withSpan` | unnamed spans |

## Canonical shapes

Service with traced methods and a layer that leaves its dependencies open:

```ts
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

export class UserNotFound extends Schema.TaggedError<UserNotFound>()("UserNotFound", {
  userId: UserId
}) {
  override get message(): string {
    return `No user has id ${this.userId}.`
  }
}

export class UserService extends Context.Service<UserService>()("app/UserService", {
  make: Effect.gen(function*() {
    const repo = yield* UserRepo

    const findById = Effect.fn("UserService.findById")(function*(id: UserId) {
      const user = yield* repo.findById(id)
      return yield* Effect.fromOption(user, () => new UserNotFound({ userId: id }))
    })

    return { findById }
  })
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
```

`UserService.layer` is `Layer<UserService, never, UserRepo>`. The edge wires it, once:

```ts
const MainLayer = UserService.layer.pipe(Layer.provide(UserRepo.layer))
```

A test provides a fake `UserRepo` instead. A dependency provided inside a layer is never replaced by one provided around it, so a `layer` that wires its own dependencies can't be tested over fakes. Effect's ai-docs keep an open `layerNoDeps` beside each wired layer, and its janitor app keeps only the open one, as `layer`, and wires everything at the edge.

App entrypoint (Bun):

```ts
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Effect from "effect/Effect"

program.pipe(Effect.provide(MainLayer), BunRuntime.runMain)
```

## Effect Language Server (recommended)

Install `@effect/tsgo` with `typescript@7` and run `npx @effect/tsgo setup`. The plugin name in `tsconfig.json` stays `{ "plugins": [{ "name": "@effect/language-service" }] }`. Select the workspace TypeScript version. It catches floating effects, missing requirements, and wrong yield patterns at edit-time.

## Reference map

- `references/index.md` — top-level navigation.
- `references/core/index.md` — effects, error handling, data types.
- `references/services/index.md` — services, layers, runtime/scope, config.
- `references/schema/index.md` — schema, branded types, codecs.
- `references/concurrency/index.md` — concurrency, fibers, streams, queues, scheduling, batching.
- `references/observability/index.md` — logging, tracing, metrics, OpenTelemetry.
- `references/cli/index.md` — commands, flags, validation, output, testing a CLI.
- `references/networking/index.md` — HTTP client, HttpApi, RPC, Workflow, Cluster.
- `references/sql/index.md` — clients, queries, schemas, models, migrations.
- `references/ai/index.md` — language models, providers, tools, structured output, embeddings, chat.
- `references/atom/index.md` — reactive state and React bindings.
- `references/platform-bun/index.md` — Bun runtime, services, HTTP server.
- `references/testing/index.md` — `@effect/vitest`, `bun:test`, fakes.
- `references/anti-patterns.md` — forbidden patterns and v3 holdovers.
