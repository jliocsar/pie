---
name: effect-best-practices
description: Effect v4 patterns for effects, services, layers, schema, errors, concurrency, observability, SQL, AI, atoms, and testing. Use when writing or reviewing TypeScript code that uses Effect (the `effect` package or `@effect/*`).
---

# Effect v4 Best Practices

Opinionated, verified patterns for Effect v4 (`effect@4.x` and `@effect/*`). Optimized for type safety, testability, observability, and tracing. All rules are verified against the Effect v4 source — they differ substantially from Effect v3.

Supported packages: `effect`, `@effect/atom-react`, `@effect/opentelemetry`, `@effect/platform-bun`, `@effect/sql-*`, `@effect/ai-*`, `@effect/vitest`.

## How to use this skill

Start at `references/index.md` and navigate to the relevant pillar. Each folder's `index.md` lists its files. Consult the specific reference before writing non-trivial code in that area — the v4 APIs are easy to get wrong from memory.

## Critical rules (apply always)

| Topic | DO | DON'T |
| --- | --- | --- |
| Imports | leaf modules: `effect/Effect`, `effect/unstable/cli/Command` | barrels: `from "effect"`, `effect/testing`, `effect/unstable/http` |
| Authoring | `Effect.gen` + `Effect.fn("name")`, attach combinators via `.pipe` | functions returning `Effect.gen`; `.pipe` on `Effect.fn` |
| Failing in gen | `return yield* new SomeError(...)` | bare `yield*` of an error mid-block |
| Services | `Context.Service<X>()("id", { make })` + hand-written `static layer` | `Effect.Service` (gone); assuming `.Default` |
| Deps | resolve via `yield*` inside `make`, platform services and `Config` included, so methods carry no requirements | `Service.use` everywhere; `yield* FileSystem.FileSystem` in free functions |
| Layers | `mergeAll` (independent), `provide` (hide dep), `provideMerge` (expose) | deep `Layer.provide` chains |
| Errors | `Schema.TaggedError<Self>()("Tag", {...})`, one per failure reason | `Schema.TaggedErrorClass` (not in rc.117); generic shared errors |
| Catch | `Effect.catch` / `catchTag` / `catchTags` / `catchCause` | `catchAll` / `catchSome` (renamed) |
| Tags | `catchTag` / `catchReason` / `Match.tag` / `Match.tagsExhaustive` | reading `x._tag` or `error.reason._tag` |
| Result type | `Result` (yieldable) | `Either` (gone) |
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

Service with traced methods and a hand-wired layer:

```ts
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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
      return yield* Option.match(user, {
        onNone: () => new UserNotFound({ userId: id }),
        onSome: Effect.succeed
      })
    })

    return { findById }
  })
}) {
  static readonly layer = Layer.effect(this)(this.make).pipe(Layer.provide(UserRepo.layer))
}
```

App entrypoint (Bun):

```ts
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as Effect from "effect/Effect"

program.pipe(Effect.provide(MainLayer), BunRuntime.runMain)
```

## Effect Language Server (recommended)

Install `@effect/language-service` and add `{ "plugins": [{ "name": "@effect/language-service" }] }` to `tsconfig.json`, then select the workspace TypeScript version. It catches floating effects, missing requirements, and wrong yield patterns at edit-time.

## Reference map

- `references/index.md` — top-level navigation.
- `references/core/index.md` — effects, error handling, data types.
- `references/services/index.md` — services, layers, runtime/scope, config.
- `references/schema/index.md` — schema, branded types, codecs.
- `references/concurrency/index.md` — concurrency, fibers, streams, queues, scheduling, batching.
- `references/observability/index.md` — logging, tracing, metrics, OpenTelemetry.
- `references/networking/index.md` — HTTP client, HttpApi, RPC, Workflow, Cluster.
- `references/sql/index.md` — clients, queries, schemas, models, migrations.
- `references/ai/index.md` — language models, providers, tools, structured output, embeddings, chat.
- `references/atom/index.md` — reactive state and React bindings.
- `references/platform-bun/index.md` — Bun runtime, services, HTTP server.
- `references/testing/index.md` — `@effect/vitest`.
- `references/anti-patterns.md` — forbidden patterns and v3 holdovers.
