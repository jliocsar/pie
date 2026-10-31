# Services Pillar

Effect v4 dependency injection: services, layers, runtime/scope, and config.

- [services.md](./services.md) — `Context.Service` canonical pattern, hand-written `static readonly layer`, one service per outside system, swapping a layer in tests, `Context.Reference`, accessors, `Effect.fn` methods.
- [layers.md](./layers.md) — `merge`/`provide`/`provideMerge`, `Layer.effect`/`unwrap`, memoization/`fresh`, bootstrap assembly, `Command.provide` per subcommand.
- [runtime-and-scope.md](./runtime-and-scope.md) — `runMain`/`Layer.launch`/`ManagedRuntime`, `Scope`/`acquireRelease`/finalizers, `LayerMap.Service`.
- [config.md](./config.md) — schema-backed `Config.*`, `Config.all`/`withDefault`/`Redacted`, `ConfigProvider` for tests, no `process.env`.
