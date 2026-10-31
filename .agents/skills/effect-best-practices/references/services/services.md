# Services

`Context.Service` is the v4 service constructor. Type params come FIRST; the id string is passed to the returned function. A service Key IS an `Effect<Shape, never, Identifier>`, so `yield* MyService` retrieves it.

## v3 → v4

- DON'T use `Effect.Service` — it does NOT exist in v4. Use `Context.Service`.
- `Context.Tag(id)<Self,Shape>()` → `Context.Service<Self,Shape>()(id)`.
- `Context.GenericTag<T>(id)` → `Context.Service<T>(id)`.
- `Effect.Tag` proxy accessors REMOVED → use `Service.use`/`Service.useSync`, or prefer `yield*`.
- `Context` is NOT renamed (it is not `ServiceMap`). A `Context<Services>` is the env collection.
- There is NO auto-generated `.Default` or `.layer` static. The `make` option only sets a `.make` static; it does NOT create a layer. You write `static readonly layer` yourself.

## Canonical pattern — class with `make` (preferred)

Deps resolved via `yield*` inside `make`; layer wired by hand.

```ts
export class Rollup extends Context.Service<Rollup>()(
  "@effect/bundle/Rollup",
  {
    make: Effect.gen(function*() {
      const pathService = yield* Path.Path
      const fs = yield* FileSystem.FileSystem
      const bundle = Effect.fn("Rollup.bundle")(function*(options: BundleOptions) { /* ... */ })
      return { bundle }
    })
  }
) {
  static readonly layer = Layer.effect(this)(this.make)
}
```

`make` returns a plain object. Calling the class's own `.of({ ... })` inside the `make` passed to `Context.Service` does NOT compile in rc.117: `make` is part of the class's base expression, so TypeScript reports `TS2506: 'Rollup' is referenced directly or indirectly in its own base expression` — with the shape inferred (`<Self>()`) and with it declared (`<Self, Shape>()`) alike. To pin the shape, declare it as the second type parameter: `make`'s result is then checked against it at the `return`. `.of` is fine anywhere outside the base expression, e.g. `Layer.succeed(Rollup, Rollup.of({ ... }))`.

`Layer.effect(this, this.make)` and curried `Layer.effect(this)(this.make)` are both valid:

```ts
export class Fixtures extends Context.Service<Fixtures>()(
  "@effect/bundle/Fixtures",
  { make: Effect.gen(function*() { /* ... */ return { fixtures, fixturesDir } }) }
) {
  static readonly layer = Layer.effect(this, this.make)
}
```

## One service per outside system

Each outside system the program talks to (a directory tree, a remote API, a CLI tool it spawns) is one service. Its `make` resolves the platform services AND the `Config` it needs, once, so its methods carry no requirements and no caller sees `FileSystem`, `Path`, `HttpClient`, `ChildProcessSpawner` or an env var. Declaring the shape as the second type parameter pins it.

```ts
export class Profiles extends Context.Service<
  Profiles,
  { readonly load: (name: PathSegment) => Effect.Effect<Profile, PlatformError.PlatformError | Schema.SchemaError> }
>()("app/Profiles", {
  make: Effect.gen(function*() {
    const fileSystem = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const homeDirectory = yield* Config.String("HOME")
    const configDirectory = yield* Config.String("XDG_CONFIG_HOME").pipe(
      Config.withDefault(path.join(homeDirectory, ".config"))
    )

    const load = Effect.fn("Profiles.load")(function*(name: PathSegment) {
      const text = yield* fileSystem.readFileString(path.join(configDirectory, "app", `${name}.json`))
      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Profile))(text)
    })

    return { load }
  })
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
```

`Profiles.layer` is `Layer<Profiles, Config.ConfigError, FileSystem.FileSystem | Path.Path>`: the requirements and the config failure surface once, where the layer is provided, instead of in every signature that touches a file. `PathSegment` and `Profile` are boundary schemas; see `../schema/boundaries.md`.

- DO resolve each env var in exactly one `make`. A second module needing the same directory asks the service that owns it.
- DON'T write free functions that `yield*` platform services or `Config` — each one adds to every caller's requirements and re-reads config on every call.

## Testing: swap the layer

A service is the seam. Tests provide a different layer for it instead of faking the transport underneath.

```ts
const ProfilesTest = Layer.succeed(Profiles, {
  load: () => Effect.succeed({ tags: [], servers: [] })
})
// only the members the test touches; an omitted one dies with `UnimplementedError` if called:
const ProfilesMock = Layer.mock(Profiles, { load: () => Effect.succeed({ tags: ["x"], servers: [] }) })

program.pipe(Effect.provide(ProfilesTest))
```

To test the service itself, keep its real layer and provide its dependencies instead: `Profiles.layer.pipe(Layer.provide(Layer.mergeAll(FileSystem.layerNoop({ readFileString: () => Effect.succeed("{}") }), Path.layer, ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/home/test" })))))`.

## Scoped resource via `make`

Resource acquired in `make` is released when the layer scope closes.

```ts
export class PgContainer extends Context.Service<PgContainer>()("test/PgContainer", {
  make: Effect.acquireRelease(
    Effect.tryPromise({ try: () => new PostgreSqlContainer("postgres:alpine").start(),
                        catch: (cause) => new ContainerError({ cause }) }),
    (container) => Effect.promise(() => container.stop())
  )
}) {
  static readonly layer = Layer.effect(this)(this.make)
}
```

## Class without `make` (simple value services)

```ts
class Database extends Context.Service<Database, {
  readonly query: (sql: string) => Effect.Effect<string>
}>()("Database") {}
// provide with Layer.succeed(Database, { query: ... }) or Layer.effect(Database, makeEff)
```

## id naming convention

- DO make the id string `package + path`, e.g. `"@effect/bundle/Rollup"`, `"myapp/db/Database"`. The id is the runtime identity.
- DON'T reuse one id string across unrelated services — they collide in the same Context slot.

## Context.Reference — defaulted services

For config/feature-flags/anything with a sensible default; no provision needed. Getter returns the default when no override is provided.

```ts
export const UndiciOptions = Context.Reference<Partial<Undici.Dispatcher.RequestOptions>>(
  "@effect/platform-node/NodeHttpClient/UndiciOptions",
  { defaultValue: () => ({}) }
)
```

```ts
class Interrupts extends Context.Reference("Interrupts", { defaultValue: () => ({ interrupts: 0 }) }) {}
```

- DO use `Context.Service` when the dependency MUST be provided (fails if missing).
- DO use `Context.Reference` when a cached default is acceptable.

## Accessors: `use`/`useSync` vs `yield*`

- `Service.use(f)` → `Effect<A, E, R | Identifier>`; `Service.useSync(f)` → `Effect<A, never, Identifier>`.
- DO prefer `yield*` over `use`. `use` leaks the dependency into return values and hides the requirement at the call site.
- DO use `use` only for trivial one-liners.

## Service methods

- DO wrap method implementations in `Effect.fn("Name.method")(...)` so spans get named.
