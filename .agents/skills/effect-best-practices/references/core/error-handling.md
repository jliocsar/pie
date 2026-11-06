# Error Handling

## Defining errors

- DO use `Schema.TaggedError<Self>()("Tag", { fields })` — the recommended way for schema-backed/serializable errors. Also `Schema.Error` (no tag).
- `Data.TaggedError("Tag")<{...}>` and `Data.Error` also exist — produce `Cause.YieldableError` and are yieldable in `Effect.gen` to fail the effect. `Data.TaggedError` works with `catchTag`/`catchTags`, and its `_tag` is excluded from constructor args. `Data.Error` has no tag, so catch it with `Effect.catch`. Prefer `Schema.TaggedError` for serializable errors.
- For defect/unknown causes inside an error schema, use `cause: Schema.Defect()` (it's a factory — bare `Schema.Defect` is not a schema).
- DO include context fields (IDs, inputs) in error classes.

```ts
class AiError extends Schema.TaggedError<AiError>()("AiError", {
  reason: Schema.Union([RateLimitError, QuotaExceededError, SafetyBlockedError])
}) {}
```

## v3 → v4 catch renames

| v3 | v4 |
|---|---|
| `Effect.catchAll` | `Effect.catch` |
| `Effect.catchAllCause` | `Effect.catchCause` |
| `Effect.catchAllDefect` | `Effect.catchDefect` |
| `Effect.catchSome` | `Effect.catchFilter` (uses `Filter` module, not `Option`) |
| `Effect.catchSomeCause` | `Effect.catchCauseFilter` |
| `Effect.catchSomeDefect` | REMOVED |
| `Effect.catchTag` | unchanged |
| `Effect.catchTags` | unchanged |
| `Effect.catchIf` | unchanged |

General rule: `catchAll*` → `catch*`; `catchSome*` → `catch*Filter`.

- DON'T use v3 names: `catchAll`, `catchAllCause`, `catchSome` — all renamed.

## Tag-based catching

- `Effect.catchTag("Tag", handler)` — single tag. Also accepts an ARRAY of tags:

```ts
Effect.catchTag(["ParseError", "ReservedPortError"], (_) => Effect.succeed(3000))
```

- `Effect.catchTags({ TagA: handlerA, TagB: handlerB })` — object of per-tag handlers.

## catch / catchCause

- `Effect.catch((error) => ...)` — catch-all over the typed error channel only, NOT defects.
- `Effect.catchCause((cause) => ...)` — catch including defects/interrupts.
- DO combine: catch specific tags first, then a final `Effect.catch` fallback.
- `Effect.catchEager` — optimization variant of `catch` that evaluates synchronous recovery effects immediately.

## Reason-based errors

For a tagged error whose payload has a `reason: Schema.Union([...])` field:

```ts
// Handle one reason (+ optional catch-all for other reasons):
Effect.catchReason("AiError", "RateLimitError",
  (reason) => Effect.succeed(`Retry after ${reason.retryAfter}s`),
  (reason) => Effect.succeed(`Failed: ${reason.message}`))

// Handle several reasons:
Effect.catchReasons("AiError", {
  RateLimitError: (r) => Effect.succeed(`...`),
  QuotaExceededError: (r) => Effect.succeed(`...`)
})

// Or move reasons into the error channel, then use catchTags:
callModel.pipe(Effect.unwrapReason("AiError"), Effect.catchTags({ /* ... */ }))
```

## Never read `_tag`

A read keeps compiling when a variant is added, so the new case goes unhandled. An exhaustive match stops compiling instead, which is the whole reason for the ban. `_tag` isn't hidden: Effect itself declares it as a schema field.

| Need | DO | DON'T |
| --- | --- | --- |
| Every variant | `Match.tagsExhaustive`, `Union.match` | `switch (value._tag)` with a `default` |
| One variant | `Union.guards.X(value)` | `value._tag === "X"`; `Predicate.isTagged(value, "X")`, which takes `unknown`, so a typo compiles |
| One error tag | `Effect.catchTag`, `Effect.catchReason` | catch-all, then probing the tag |
| A deliberate fallback | `Match.tag` + `Match.orElse`: it gives up exhaustiveness just as a read does, so a new variant lands in the fallback silently | reaching for it to avoid writing the other cases |

```ts
const Shape = Schema.TaggedUnion({
  Circle: { radius: Schema.Number },
  Rectangle: { width: Schema.Number, height: Schema.Number }
})

if (Shape.guards.Circle(shape)) {
  yield* Effect.log(shape.radius)
}
```

- `Union.guards` exists on `Schema.TaggedUnion` and on `Schema.Union([...]).pipe(Schema.toTaggedUnion("_tag"))`, including a union of `Schema.TaggedError` classes.
- A guard is `(u: unknown) => u is Member`, but its key is checked, so `Shape.guards.Circl` doesn't compile. It validates the whole value against the member's type side, not just the tag.
- A `Data.taggedEnum`'s guard is `$is("X")`, with the tag checked too.

## Other error-channel combinators

- `Effect.mapError`, `Effect.tapError`, `Effect.orDie` (makes E fatal/defect), `Effect.orElseSucceed`. There is no `Effect.orElse` in 4.1.2.

## Cause flattened to reasons

- `Cause<E>` now holds a FLAT `reasons: ReadonlyArray<Reason<E>>`. Each `Reason` is one of `Fail<E>`, `Die`, `Interrupt`, each carrying an `annotations` map (stack frames / spans). Empty `reasons` = empty/success cause.
- Create: `Cause.fail(e)`, `Cause.die(defect)`, `Cause.interrupt(fiberId?)`, `Cause.fromReasons`.
- Test: `Cause.hasFails` / `Cause.hasDies` / `Cause.hasInterrupts`; narrow reasons with `Cause.isFailReason` / `isDieReason` / `isInterruptReason`.
- `Cause.squash`, `Cause.interruptors`.

## Exit

- `Exit<A, E>` = `Success<A, E> | Failure<A, E>`. `Failure` carries `cause: Cause<E>`.
- `Exit.succeed`, `Exit.fail`, `Exit.failCause`, `Exit.isSuccess` / `isFailure`.
