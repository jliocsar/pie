# Boundaries

Data enters a program in three places: CLI arguments, the environment, and files (including values the program wrote to disk itself on an earlier run). Each gets a Schema decode where it enters, and everything past that point holds the decoded type. Downstream code never re-validates, re-probes or re-reads.

## One schema, three entry points

```ts
const profile = Argument.String("profile").pipe(Argument.withSchema(PathSegment))   // CLI (effect/unstable/cli/Argument)
const region = yield* Config.schema(HostLabel, "REGION")                             // env
const loaded = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Profile))(text) // file
```

`Flag.withSchema` is the same for flags. A rejected CLI value fails parsing with the schema's message, before the handler runs.

- DO decode a remembered value (last-used target, cached state) with the same schema as the CLI value it came from. The disk is an entry point too.
- DON'T build a path or URL from a raw `string` because a schema for it exists elsewhere. If it reaches a path or URL, it is the branded type.

## Values that become a path segment or a URL host

A brand alone checks nothing (`Schema.brand` is type-only). Put the check on the base, then brand:

```ts
export const PathSegment = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/)).pipe(
  Schema.brand("PathSegment")
)
export type PathSegment = typeof PathSegment.Type

export const HostLabel = Schema.String.check(Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)).pipe(
  Schema.brand("HostLabel")
)
export type HostLabel = typeof HostLabel.Type
```

`PathSegment` rejects `.`, `..`, anything with `/`, and a leading `-`; `HostLabel` rejects `.`, `/`, `@` and `:`, so `https://${label}.example.com` cannot be redirected to another host.

## Paths relative to different roots get different brands

One `string` field holding home-relative paths in one place and repository-relative paths in another makes every reader guess the root. Share the check, split the brand (or the field name):

```ts
const RelativePath = Schema.String.check(Schema.isPattern(/^(?!\/)(?!(?:.*\/)?\.\.(?:\/|$)).+$/))
export const HomeRelativePath = RelativePath.pipe(Schema.brand("HomeRelativePath"))
export const RepositoryRelativePath = RelativePath.pipe(Schema.brand("RepositoryRelativePath"))
```

`RelativePath` rejects an absolute path and any `..` segment.

## Decode to the tagged shape, not to a structural one

A wire format whose variants carry no discriminator still decodes to a tagged union: `tagDefaultOmit` fills `_tag` on decode and strips it on encode, and `toTaggedUnion` adds `match`/`guards`/`cases`.

```ts
export const Server = Schema.Union([
  Schema.Struct({ _tag: Schema.tagDefaultOmit("Http"), url: Schema.String }),
  Schema.Struct({ _tag: Schema.tagDefaultOmit("Stdio"), command: Schema.String })
]).pipe(Schema.toTaggedUnion("_tag"))
export type Server = typeof Server.Type

// { url } decodes to { _tag: "Http", url }; { command } to { _tag: "Stdio", command }
Server.match(server, { Http: (http) => http.url, Stdio: (stdio) => stdio.command })
```

- DON'T decode the structural union and convert it later with `Schema.is(Member)` checks — that is a second decoder nobody keeps in sync.

## One representation of "none"

When most lists default to `[]`, all of them do. An optional list beside defaulted ones gives readers two spellings of empty.

```ts
export const Profile = Schema.Struct({
  tags: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  servers: Schema.Array(Server).pipe(Schema.withDecodingDefaultKey(Effect.succeed([])))
})
export type Profile = typeof Profile.Type  // tags: ReadonlyArray<string>, never undefined
```

The same goes for `Option`: absence is `Option.none()` (`OptionFromNullOr`, `optionFromOptionalKey`), not sometimes `undefined`.

## A schema is a boundary contract

- DON'T declare a `Schema.Struct` that nothing decodes or encodes just to derive a type — write the type.
