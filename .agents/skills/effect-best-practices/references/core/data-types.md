# Data Types

## Option

- `Option.match(self, { onNone, onSome })`, `Option.getOrElse(self, () => default)`.
- `Option.getOrUndefined`, `Option.getOrThrow`.
- DON'T use `Option.getOrThrow` in Effect code — recover Options into the Effect error channel with `Effect.fromOption(option, () => new SomeError(...))`. `Effect.fromNullishOr` is for null and undefined: given an `Option.none()` it succeeds with the Option.

## Either → Result (renamed in v4)

There is NO `Either.ts`; the core data type is `Result`.

- `Result<A, E>` = `Success<A, E> | Failure<A, E>`. `E` defaults to `never`.
- `Result.succeed(a)`, `Result.fail(e)`, `Result.match`, `Result.getOrElse`, `Result.isSuccess`, `Result.isFailure`.
- `Result` is yieldable in `Result.gen`, not in `Effect.gen`, where it's a type error and dies at runtime: lift it with `Effect.fromResult`. It is a monad (`flatMap`/`andThen`/`tap`/`pipe`), pure/immutable.
- Schema also renamed Either-flavored APIs: `EitherFromSelf`→`Result`, `decodeUnknownEither`→`decodeUnknownResult`, `decodeEither`→`decodeResult`. The `*Exit` variants exist too.

## Data

- `Data.Class`, `Data.TaggedClass`, `Data.Error`, `Data.TaggedError`, `Data.taggedEnum` (TaggedEnum / ADTs).
- Use Data for discriminated-union modelling. `Equal.equals` is already structural for plain objects and class instances, so Data adds no equality of its own, and `Data.Error`/`Data.TaggedError` instances compare by reference.

### TaggedEnum / taggedEnum (ADTs)

`Data.TaggedEnum<{...}>` is the TYPE (each key → a `_tag` variant). `Data.taggedEnum<T>()` returns the runtime helper: one constructor per variant, plus `$is` and `$match`.

```ts
import * as Data from "effect/Data"

type HttpError = Data.TaggedEnum<{
  BadRequest: { readonly message: string }
  NotFound: { readonly url: string }
}>

const { BadRequest, NotFound, $is, $match } = Data.taggedEnum<HttpError>()

const err = NotFound({ url: "/x" })          // { _tag: "NotFound", url: "/x" } — plain object
$is("NotFound")(err)                          // type-guard: checks ONLY _tag
$match(err, {                                 // exhaustive; data-first OR data-last (cases only)
  BadRequest: (e) => e.message,
  NotFound: (e) => `${e.url} nf`
})
```

- Generic variants: extend `Data.TaggedEnum.WithGenerics<N>` with `readonly taggedEnum: MyType<this["A"], ...>`, then `Data.taggedEnum<Def>()`.
- DO: use for closed unions of plain data with value-equality; constructors produce plain objects (NOT class instances).
- DON'T: trust `$is`/`$match` on untrusted input — `$is` only checks `_tag`. Validate with `Schema` first.

## Duration

- Durations accept string inputs like `"30 seconds"`, `"1 second"`, `"200 millis"` directly in most APIs.
- Constructors: `Duration.millis/seconds/minutes/hours/days/weeks/nanos/micros`.
- Conversions: `Duration.toMillis/toSeconds/...`; `Duration.fromInput` (safe, returns Option), `Duration.fromInputUnsafe`. `Duration.match`, `Duration.between`, `Duration.Order`, `Duration.Equivalence`.

## Function: pipe / flow

- `pipe(a, ab, bc, ...)` — value-first pipeline; same as the `.pipe()` method on pipeable types.
- `flow(...)` — point-free composition of functions.
- Helpers: `identity`, `constant`, `constVoid` / `constUndefined` / `constNull` / `constTrue` / `constFalse`.
