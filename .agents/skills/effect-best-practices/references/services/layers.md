# Layers

Compose services with `merge`/`provide`/`provideMerge`. Layers are memoized by default. Attach as `static readonly layer` on the service class, leaving the service's own dependencies open: the edge wires them, and a test provides fakes instead.

## Combinator selection

| Combinator | Output type | Use when |
|---|---|---|
| `Layer.merge(a, b)` / `Layer.mergeAll(...)` | `ROut_a \| ROut_b`, requirements unioned | Combine INDEPENDENT services (neither needs the other). |
| `self.pipe(Layer.provide(dep))` | only `self`'s ROut; `dep`'s outputs satisfy `self`'s requirements and are HIDDEN, and `dep`'s own requirements stay open | Feed a dependency into `self` and HIDE it from callers (`Exclude<RIn2, ROut>`). |
| `self.pipe(Layer.provideMerge(dep))` | `self` ROut + `dep` ROut both exposed | Feed dep into self AND keep dep visible downstream. |

```ts
const UserRepositoryLayer = UserRepository.layer.pipe(Layer.provide(SqlClientLayer))
const UserRepositoryWithSqlClientLayer = UserRepository.layer.pipe(Layer.provideMerge(SqlClientLayer))
```

That wiring lives at the edge, never in the service's own `layer`. A dependency provided inside a layer is never replaced by one provided around it (measured: a test's fake `Dep` lost to the real one a closed layer provided itself), so a closed layer leaves a test nothing to fake but the outside world.

## Layer.effect

Build a service layer from an effect that produces its shape.

```ts
static readonly layer = Layer.effect(this)(this.make)
```

## Layer.sync — lazy synchronous service

Provide ONE service whose value is built synchronously, deferred until the layer is built (lazy `succeed`). `Layer.sync(Service, () => impl)`.

```ts
static readonly layer = Layer.sync(this, () => ({ query: (sql: string) => Effect.succeed(`Query: ${sql}`) }))
```

## Layer.effectContext — one acquisition, MANY tags

Build a `Context` holding MULTIPLE services in a single effect and expose them all: `Layer.effectContext(eff): Layer<A, E, Exclude<R, Scope>>` where `eff: Effect<Context.Context<A>, E, R>`. Use when one acquisition step yields several related services.

```ts
static readonly layer = Layer.effectContext(Effect.gen(function*() {
  const conn = yield* openConnection
  return Context.empty().pipe(Context.add(Reader, mkReader(conn)), Context.add(Writer, mkWriter(conn)))
}))
```

(`Context.make(Tag, impl)` also works for the single-tag case; `Layer.effect`/`Layer.sync` are simpler when providing just one.)

## Layer.unwrap — config-driven dynamic layer

Returns a `Layer` from an `Effect<Layer>`; pick the implementation at build time.

```ts
static readonly layer = Layer.unwrap(Effect.gen(function*() {
  const inMem = yield* Config.Boolean("MESSAGE_STORE_IN_MEMORY").pipe(Config.withDefault(false))
  return inMem ? MessageStore.layerInMemory : MessageStore.layerRemote(yield* Config.URL("MESSAGE_STORE_URL"))
}))
```

## Bootstrap assembly

```ts
const MainLayer = Layer.mergeAll(Fixtures.layer, Reporter.layer)
  .pipe(Layer.provideMerge(NodeServices.layer))
Command.run(cli, { version }).pipe(Effect.provide(MainLayer), NodeRuntime.runMain)
```

Layers are provided at the edge and nowhere else: modules below it `yield*` the services they use and leave the requirement in their type, never `Effect.provide` mid-program.

When services depend on each other, wire them in named stages, one `provide` each, from the leaves up:

```ts
const PaymentsLayer = Payments.layer.pipe(Layer.provide(FetchHttpClient.layer))
const LeafServicesLayer = Layer.mergeAll(Settings.layer, Storage.layer, Process.layer)
const PaymentsAndMailerLayer = Layer.mergeAll(PaymentsLayer, Mailer.layer).pipe(Layer.provideMerge(LeafServicesLayer))
const AppLayer = Layer.mergeAll(Orders.layer, Accounts.layer).pipe(Layer.provideMerge(PaymentsAndMailerLayer))
```

A layer used by several stages is still built once: memoization is by reference.

### A CLI provides per subcommand

`Command.provide(layer)` (from `effect/cli/Command`) feeds a layer to ONE command's handler, so a subcommand builds only the services it uses: `--help` builds nothing, and a command that never touches the remote API never reads its token. Only the platform layer is provided once, at `run`.

```ts
const show = Command.make(
  "show",
  { profile: Argument.String("profile").pipe(Argument.withSchema(PathSegment)) },
  ({ profile }) =>
    Effect.gen(function*() {
      const profiles = yield* Profiles
      yield* Effect.log(yield* profiles.load(profile))
    })
).pipe(Command.provide(Profiles.layer))

const cli = Command.make("app").pipe(Command.withSubcommands([show, sync]))

Command.run(cli, { version }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
```

`Command.provide` also takes `(input) => Layer` when the layer depends on the parsed flags.

## Memoization + Layer.fresh

- Layers are memoized by default: yielding the same service twice returns the SAME instance. Memoization is keyed via the `MemoMap`.
- `Layer.fresh(layer)` opts OUT — builds a new instance each use.
- For multi-runtime apps share a single `MemoMap` via `Layer.makeMemoMapUnsafe()` (see `runtime-and-scope.md`).
- `Effect.provide(layer, { local: true })` opts OUT at the provide site — builds the layer FRESH, ignoring what the surrounding memo map already built. By default a provide reuses those, but sibling provides still build their own copy each (measured). Use `local: true` for isolated acquisition inside a runtime that already built the layer.

## When to prefer each

- DO attach layers as `static readonly layer` on the service class.
- DO keep layers focused (one service / small related group).
- DO leave a service's own `layer` open and wire once at the edge, one `provide` per named stage, so a test can build the real service over fakes of what it depends on.
- DON'T use `Layer.merge` where you meant `provide` — `merge` leaves deps unsatisfied/exposed; `provide` hides+consumes, `provideMerge` keeps both.
