# bun:test

`@effect/vitest` needs vitest. Under `bun test` there is no `it.effect`, `layer()` or automatic `TestClock`/`TestConsole`, so a file builds its own runtime.

## Runtime per file

```ts
import * as BunServices from "@effect/platform-bun/BunServices"
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"

const runtime = ManagedRuntime.make(Profiles.layer.pipe(Layer.provideMerge(BunServices.layer)))

afterAll(() => runtime.dispose())

describe("Profiles", () => {
  test("loads a profile", () =>
    runtime.runPromise(
      Effect.gen(function*() {
        const profiles = yield* Profiles
        expect(yield* profiles.load(profileName)).toEqual(expected)
      })
    ))
})
```

- DO return the `runPromise` promise from `test`, so a failure fails the test.
- DO `Effect.scoped` anything that acquires, since nothing wraps the test in a scope for you.
- DON'T use `mock.module`: `begone-slop/no-module-mocking` rejects it, and an open `layer` makes it unnecessary.

## Fakes

A service's `layer` leaves its dependencies open (see `../services/layers.md`), so a test provides fakes of exactly those:

```ts
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import * as TestConsole from "effect/testing/TestConsole"

const ReflectionLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ tags: [] }))))
)

const NoProcessesLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected spawn"))
)

const TagsUnderTest = Tags.layer.pipe(Layer.provide(ReflectionLayer))
```

- A fake service that records calls keeps them in a `Ref` service, `provideMerge`d beside it so the test can read it back.
- `TestConsole.layer` replaces `Console.Console`; read what was printed with `TestConsole.logLines` / `TestConsole.errorLines`.
- `TestClock` is not installed for you: provide `TestClock.layer()` where a test needs virtual time.
