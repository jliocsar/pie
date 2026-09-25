# AGENTS.md

Effect v4 TypeScript monorepo boilerplate. Toolchain, lint rules, conventions — no product code.
Members live in `packages/*`. `packages/tsconfig` holds the shared TS base every member extends.

Toolchain is oxc + TypeScript 7: `oxlint` (lint), `oxfmt` (format), `typescript@7` with
`@effect/tsgo`. No ESLint, no dprint, no Prettier.

The house lint rules are `@jliocsar/begone-slop`, a published oxlint plugin developed in its own repo. It is
an ordinary dependency here: `.oxlintrc.json` loads it by bare specifier and extends its
`preset.json` through an explicit `./node_modules/` path, because `jsPlugins` resolves a package
specifier and `extends` does not (measured).

:::warning
Fix a rule in the `begone-slop` repo, never here — there is nothing to edit in this one. It ships
compiled ESM, so `node_modules/@jliocsar/begone-slop/dist` is build output. Reach for `bun run lint` and read
its `README.md` for the rule list.

The same goes for the compiler settings: the package publishes the house tsconfig as
`@jliocsar/begone-slop/tsconfig`, and `packages/tsconfig/base.json` extends it. A house-wide
compiler option is a release of that package, exactly like a rule.

`lint` passes `--no-error-on-unmatched-pattern`: this repo carries no product code, and oxlint
otherwise exits non-zero when it matches no files, failing the gate on an empty template.
:::

The 81 `effecttsgo/*` Effect rules come from `@effect/tsgo`'s `recommended` preset, which
`.oxlintrc.json` extends. They are type-aware, and the preset turns type-aware mode on — which is
why no `--type-aware` flag appears in the scripts.

The preset ships most of them as `warn`, so every lint invocation passes `--deny-warnings`: a
warning that cannot fail the gate is one nobody fixes. Downgrade individual rules in
`.oxlintrc.json` rather than dropping the flag.

`.oxlintrc.json` also enables oxlint's own `correctness`, `suspicious` and `pedantic` categories.
Pedantic is the one that bites, because its size and shape caps were written for ordinary
TypeScript rather than for this style. `max-classes-per-file` is off for exactly that reason: one
tagged error class per failure reason is the error doctrine here, so a module that can fail two
ways already declares two classes, and a service tag makes a third. A cap of one never shrinks a
module — it scatters one concern across several files and leaves the import graph with nodes that
exist only to satisfy a linter. Its sibling `max-lines` is raised from a default of 300 (measured) to 1000, for the same
reason: a line cap relocates code rather than shrinking it, and a module split to sit under
one is a module the graph did not ask for.

:::warning
`prepare` runs `effect-tsgo patch --oxlint`, which patches the oxlint and TypeScript binaries in
`node_modules`. Without it the Effect rules do not run. It is not optional and it re-runs on every
install — do not "simplify" `prepare` down to `husky`.

It also validates that `oxlint`, `oxlint-tsgolint` and `@effect/tsgo` are a supported triple, so
bump the three together.

Any reinstall reverts the patch, and `prepare` then refuses to redo it because its backups still
exist — `Unknown plugin: 'effecttsgo'` is what that looks like. Run `bunx effect-tsgo unpatch
--oxlint` first, then `bun run prepare` (measured, twice).
:::

:::warning
`typescript` AND `oxlint` are pinned EXACTLY (no `^`). `@effect/tsgo` ships prebuilt artifacts for
specific builds of each and fails with `ReplacementUnavailableError: Missing packaged artifact`
against any other one. Bump them with `@effect/tsgo`, or not at all.

The caret is the trap, not the version: `@effect/tsgo@0.36.1` carries oxlint artifacts for `1.76.0`
and `1.77.0` only, so `^1.77.0` resolves to `1.78.0` on any fresh install and the patch dies
(measured). A committed lockfile hides this until someone clones without one.
:::

Effect diagnostics are reported by oxlint only: the published base configures the language-service
plugin with `diagnostics: false` so they do not appear twice. That block inherits through `extends`
— measured, along with the fact that a child config can set `diagnostics: true` to get the compiler
reporting them again.

The published base follows <https://www.effect.solutions/tsconfig> minus what a no-emit Bun project
cannot use, and `begone-slop`'s README says which four recommendations are out and why. Everything
local to this repo lives in `packages/tsconfig/base.json`, which today is `types: ["bun"]` and
nothing else.

## First

:::warning
Invoke the `effect-best-practices` skill before writing Effect code. Follow it as absolute truth.
Do not duplicate it here — read it.
:::

Gate every change, all four:

```sh
bun run typecheck && bun run lint && bun run test && bun run fmt:check
```

Auto-fix: `bun run lint:fix && bun run fmt`. Run `fmt` before `lint:fix` — formatting moves line
breaks, and the spacing rules judge the result.

## Layout

- Shared code goes in a `packages/*` member, reached by package specifier — never a relative path
  across members. Not lintable in a flat layout (a sibling climb spells `../../other`, naming no
  directory), so it is on you. If the import you want is not exported, export it.
- `packages/tsconfig` has no `scripts` at all: it ships a tsconfig and nothing runnable.
- There is no root `tsconfig.json`. Every member owns its own and extends the shared base.

:::warning
A member that extends the shared base must depend on it, or the extends does not resolve:

```jsonc
// packages/<member>/package.json
{ "devDependencies": { "@boilerplate/tsconfig": "workspace:*" } }
```

```jsonc
// packages/<member>/tsconfig.json
{ "extends": "@boilerplate/tsconfig/base.json", "include": ["src/**/*.ts"] }
```

Bun links a workspace member into `packages/<member>/node_modules` only where something declares it,
and nothing hoists it to the root — so without that dependency the compiler reports
`File '@boilerplate/tsconfig/base.json' not found` (measured). The second hop needs nothing: the
base reaches `@jliocsar/begone-slop/tsconfig` through the root install. TypeScript's `extends`
resolves a package specifier through the `exports` map, which is why that subpath carries no `.json`
— oxlint's `extends` is the one that cannot.
:::

:::warning
Every member with source needs a `test` script. The gate runs
`bun run --filter '*' --if-present test`, so a member without one is **skipped silently**, not
reported.
:::

## Rules

Leaf imports only: `effect/Effect`, `effect/unstable/cli/Command`.

:::warning
Every barrel is banned — the `effect` root AND each subpath index (`effect/unstable/schema`,
`effect/testing`, …). The subpath ones are what keep getting written. Enforced by a regex in
`no-restricted-imports`: a barrel is the bare root, `effect/testing`, or a single lowercase segment
under `unstable/`, since every leaf module is PascalCase. Type-only imports are exempt.
:::

:::warning
Never read `_tag`. The `_` prefix means private. Use `Match.tag`/`Match.tags`/`Match.tagsExhaustive`,
a library guard (`Cause.isTimeoutError`, `Exit.isFailure`, `Result.isFailure`), or `instanceof` where
the module instance is shared. Prefer exhaustive so a new variant fails to compile.
Enforced: `begone-slop/no-tag-access`.

Nested `reason` unions too — `SqlError`/`AiError` put the variant in `reason`, out of the failure
channel, so `catchTag` misses it and some `effect-best-practices` snippets write `error.reason._tag`.
Replacements per `references/core/error-handling.md`: `Effect.catchReason`, `Effect.catchReasons`,
`Effect.unwrapReason` + `catchTags`, or `Match.value(error.reason).pipe(Match.tagsExhaustive({…}))`.
Disable-comment only after all four fail; say which in the comment.
:::

:::warning
The other half of that: every error a call can produce in practice belongs in its **type-level**
error union, as a tagged error. Catch-all and `unknown`-shaped errors exist to SURFACE a gap, never
to be handled — catching one buries the missing case instead of naming it.

**When `Effect.catchTag('X', …)` refuses to typecheck, that is the signal**, not an obstacle. The
union is missing the error. Widen it where it is produced — the schema, the service signature, the
wrapper that swallowed it — and never loosen the catch to meet the code:

- structural probing — `Predicate.hasProperty(error, '_tag')`, `'code' in error`
- widening casts — `(error as { _tag?: string })._tag`
- catching a catch-all, then re-narrowing it by `status`/`code`/`message`

Only the second is machine-checked (it ends in a `_tag` read, so `begone-slop/no-tag-access`
rejects it — measured). The other two read as ordinary code; they are on you.

`Effect.retry`'s `while` takes a plain predicate, with no tag-based variant, so the tag-free form is
`Match.value(error).pipe(Match.tag('X', () => true), Match.orElse(() => false))`. Verbose, and still
not a licence to read `_tag`.
:::

:::warning
Error schema fields must not shadow `Error`'s own. Fields are assigned onto the instance, so a `name`
or `stack` field replaces what identifies the error as an error — `Cause.pretty`, `String(error)`,
the stack header, OTLP `exception.type`/`exception.stacktrace` all read it (measured). Name for what
it holds (`userName`), not where it sits. `message`/`cause` stay legal.
Enforced: `begone-slop/no-shadowed-error-field`.
:::

:::warning
Railway oriented programming, everywhere — the lint rules and any tooling too, not just Effect code.
A computation is a chain of `Option`/`Result`/`Effect` combinators that short-circuits, not a ladder
of guards feeding a `let`. `Option.liftPredicate` to get onto the track, `filter`/`map`/`flatMap`
along it, `getOrElse`/`match` to get off. A running accumulator is `Arr.scan`, not a mutable one.

Type narrowing is NOT the failure track. `if (node.type !== 'CallExpression') { return Option.none() }`
at the head of a function is a guard, and routing it through combinators makes it worse. The rule is
about the value flow; it does not ban `if`.
**Not enforced**: no rule can tell a guard from a fold. Review catches this one.
:::

:::warning
Locality of behaviour: what belongs to a thing lives beside it. A schema's derived type is declared
next to the schema and shares its name — `const Spec = Schema.Struct({…})` then
`type Spec = typeof Spec.Type` — never gathered into a types module.

This is why `statement-order` leaves a type alias containing `typeof` unranked: type-defs otherwise
sort above constants, which would force every schema type away from its schema.
:::

- Errors are `Schema.TaggedErrorClass` with a `message` getter: full sentence, names the fix where
  possible. One reporter prints `error.message`; an error without one exits silently.
- Module-level primitive constants are `SCREAMING_SNAKE_CASE` — they are the knobs and magic values,
  and the casing separates them from computed bindings. **Not enforced**: oxlint has no
  `naming-convention`, and the type filter that made the ESLint rule precise needs type info. Review
  catches this one.
- Descriptive, boring names. Long over clever. No abbreviations needing a decoder.
- Temp work in `tmp/` (gitignored), never `/tmp`.

:::warning
Code carries no comments. A name that needs a sentence beside it is the wrong name; a block that
needs one wants extracting. Enforced: `begone-slop/no-comments`.

The knowledge does not evaporate — it moves into this file, as a decision, a lesson learned or an
invariant worth stating. An entry here names no file, symbol or line: those rot, and an entry pinned
to a line is a comment with extra steps. Write what was decided and why it held.

Two exceptions, both narrow. A `SAFETY:` comment is required beside every type assertion and is the
only prose the rule admits. Tooling directives — `oxlint-disable`, `@ts-expect-error`, triple-slash
references, shebangs — are not comments, and the rule leaves them alone.

A number you write anywhere must be one somebody measured. If you are reaching for a plausible one,
you do not have the fact yet.
:::

`begone-slop`'s `preset.json` carries the severities and is what `.oxlintrc.json` extends — it is
the list of what is on, so read it rather than restating it here. Its `README.md` describes every
rule.

:::warning
That preset sets `"plugins": []`. Without it, extending the preset re-enables oxlint's own default
plugin set (`unicorn`, `oxc`) on top, which fails the gate on rules nobody chose (measured: 7
reports). If you want those plugins, name them in this repo's own `plugins` array — later config
wins.
:::

The ones with behaviour worth knowing before you trip on them:

- `statement-order` — imports > type-defs > constants > functions > variables > modules > exports.
- `expect-padding` — a run of `expect()` is ONE block: blank line around it, none inside. Applies to
  test files only, via an `.oxlintrc.json` override.
- `padding-line-between-statements` — the vertical-spacing spec, ported from `@stylistic`; oxlint has
  no equivalent. The spec stays declarative in `.oxlintrc.json`, as ONE array argument — `Rule.define`
  decodes `options[0]` only — validated by a `Schema` rather than by hand.
- `no-tag-access` — no `x._tag`, `switch (x._tag)`, `const { _tag } = x`. Defining a tag is fine.
- `no-shadowed-error-field` — no `name`/`stack` field on `TaggedErrorClass`/`ErrorClass`.
- `no-comments` and `require-safety-comment-for-type-assertion` are one doctrine in two rules: prose
  is banned everywhere except where an assertion demands it.

:::caution
oxlint's JS plugin support is **alpha and explicitly not semver-bound** (per its shipped config
schema). Every one of those rules rides on it, so an oxlint upgrade can change their behaviour
without a major bump. The plugin's own test suite is what catches that — after bumping oxlint here,
bump and test it there too rather than assuming the pair still agree.
:::

## Establishing a fact

Do not guess about Effect, oxc or Bun. Do not trust a plausible claim in a review.

:::tip
1. Read `node_modules/effect/src/**` — ground truth for API shape, and grepping it settles "is this
   idiomatic" (e.g. `S["Type"]` appears 98 times in `Schema.ts`). Before anything depends on
   `effect`, the hoisted copy is the same source: `node_modules/.bun/effect@*/node_modules/effect/src/**`.
   For oxlint and oxfmt, `node_modules/{oxlint,oxfmt}/configuration_schema.json` is the authoritative
   list of every option and rule — better than the docs, and it is what shipped.
2. Probe behaviour — throwaway `__probe.ts` in `tmp/`, run with `bun`, delete after. Probing oxlint
   is the exception: it skips gitignored paths, and `tmp/` is gitignored, so it reports "No files
   found to lint" (measured — it does this even with `--no-ignore`, and even for a project nested
   under the ignored directory). Probe it from a directory outside any ignored tree.
3. Record it here — never as a comment; `no-comments` rejects one anyway.
:::

## Pull requests

Conventional-commit format for the PR title AND every commit subject: `fix(lint): …`,
`feat(tsconfig): …`, `docs: …`.

The description documents the change, nothing else:

- The summary is plain prose at the very top — no heading above it, no `### Summary`. The PR title
  is already rendered; do not restate it.
- Smallest heading allowed is `###`, and only when the description genuinely splits into sections.
  Never `#` or `##`.
- Prefer a code snippet to a paragraph. A ` ```ts ` or ` ```diff ` block showing the new shape beats
  prose describing it; add prose only for the "why" a snippet cannot carry.
- Cut anything that restates the diff, and anything that reads like marketing.
- **Never** a "Test plan", "Testing", or TODO checklist. Skip examples entirely for trivial fixes,
  internal refactors and doc-only changes.

Outstanding work, manual verification or review items do NOT go in the description or a comment.
Mark the PR **draft** and say what is outstanding in the chat that asked for it.

:::warning
Write the body to a file and pass `--body-file`; never inline it:

```sh
gh pr create --body-file tmp/pr-body.md   # write it with Write, not a heredoc
```

`--body "$(cat <<'EOF' … EOF)"` mangles backticks and backslashes in some shell/`gh` combinations —
inline code spans arrive as literal `` \` ``. `--body-file` sidesteps shell quoting entirely. If
`gh pr edit --body-file` silently no-ops on an older `gh`, fall back to
`gh api -X PATCH repos/<owner>/<repo>/pulls/<n> -F body=@tmp/pr-body.md`.
:::

## Changing this file

Where review feedback gets settled once instead of repeated.

Trigger: repetition, or obvious generality. Asked twice = already a pattern, codify then. A first
request that is plainly general (`never read _tag` is about every file) gets promoted immediately.

Strongest enforcement available, in order:

1. An oxlint rule — machine-checked, cannot drift, often auto-fixable. Prefer a built-in; add a
   `begone-slop` rule, in its own repo and with its own tests, only when oxlint has none.
2. A line here — every agent reads it, but prose can be misread. A one-off measured fact goes here
   too, stated as a fact rather than a rule. Never a comment; `no-comments` rejects one.

Codify in the same change as the fix, never "later"; a pattern living only in a conversation dies
with the session.

:::warning
Rules are not immutable. When the user contradicts one, fix the rule — do not special-case the call
site. `expect-padding` was built from a misread brief and had to be inverted; that was a bug in the
rule, not licence for an exception.
:::

Do not over-codify. A preference about one file, or a judgement needing taste, is not a pattern.
