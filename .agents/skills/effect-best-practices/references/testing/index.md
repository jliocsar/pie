# testing

Effect-aware testing helpers for Effect v4 via `@effect/vitest`.

- [`bun-test.md`](./bun-test.md) — running Effect tests under `bun:test`, where `it.effect` doesn't exist: a `ManagedRuntime` per file, platform fakes and the members they need, `ChildProcess` and the process fake, `TestConsole`.
- [`vitest.md`](./vitest.md) — `it.effect`/`it.live`/`it.layer`/`layer()`, `TestClock` time control, `flakyTest`, and property testing with `prop`. Needs Vitest 5.
- [`in-memory-servers.md`](./in-memory-servers.md) — `HttpApiTest` and `McpTest.makeClient`: a real server pipeline with no port.
