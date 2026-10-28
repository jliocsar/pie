# Contributing

pie is an Effect v4 TypeScript monorepo. The `pie` binary is `packages/pie`, compiled with `bun build --compile`.

[AGENTS.md](../AGENTS.md) is the full spec: conventions, invariants, and the measured facts behind them. Read it before changing code. This page is the short human version.

## Toolchain

Everything is oxc + TypeScript 7. No ESLint, no dprint, no Prettier.

| Tool                                                                                                             | Job                                          |
| ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| [oxlint](https://oxc.rs)                                                                                         | Lint, including the type-aware pass          |
| [oxfmt](https://oxc.rs)                                                                                          | Format                                       |
| [typescript@7](https://github.com/microsoft/typescript-go) + [`@effect/tsgo`](https://github.com/Effect-TS/tsgo) | Typecheck, and 81 Effect-specific lint rules |
| [`@jliocsar/begone-slop`](https://github.com/jliocsar/begone-slop)                                               | The house lint rules                         |
| [Bun](https://bun.sh)                                                                                            | Runtime, package manager, test runner        |

## Getting started

```sh
bun install
```

`prepare` runs `husky && effect-tsgo patch --oxlint`. That patch is what makes the Effect rules run at all, so an install you skip is an install whose lint is quietly weaker. It re-runs on every install and validates that `oxlint`, `oxlint-tsgolint` and `@effect/tsgo` are a supported triple.

Then gate a change with all four:

```sh
bun run typecheck && bun run lint && bun run test && bun run fmt:check
```

Auto-fix with `bun run lint:fix && bun run fmt`. Run `fmt` first, since formatting moves the line breaks the spacing rules judge.

## Layout

```
packages/           workspace members; packages/tsconfig holds the shared TS base
.oxlintrc.json      every rule, commented where the behaviour is surprising
AGENTS.md           conventions, invariants and measured facts (CLAUDE.md symlinks to it)
docs/               these docs
skills/pie/         teaches an agent on the laptop how pie works and how to bootstrap a pod
```

Every member with source needs a `test` script: the gate runs `bun run --filter '*' --if-present test`, so a member without one is skipped in silence.

## What's enforced

Beyond oxlint's `correctness`, `suspicious` and `pedantic` categories and the `effecttsgo` preset:

- **Leaf imports only.** `effect/Effect`, not `effect`; `effect/unstable/schema/Schema`, not `effect/unstable/schema`.
- **`begone-slop/no-tag-access`**: never read `_tag`. Use `Match.tag`/`Match.tags`/`Match.tagsExhaustive` or a library guard, so a new variant fails to compile instead of falling through.
- **`begone-slop/no-shadowed-error-field`**: no `name`/`stack` field on a tagged error, which would overwrite what identifies the error as an error.
- **`begone-slop/no-comments`**: a name needing a sentence beside it is the wrong name, and durable knowledge belongs in `AGENTS.md`. `SAFETY:` comments and tooling directives are exempt.
- **`begone-slop/statement-order`**: imports > type-defs > constants > functions > variables > modules > exports.
- **`begone-slop/padding-line-between-statements`** and **`begone-slop/expect-padding`**: vertical spacing, both auto-fixable.

The full rule list is the plugin's `preset.json`, and its `README.md` describes each one.

Lint invocations pass `--deny-warnings`: the Effect preset ships most of its rules as warnings, and a warning that can't fail the gate is one nobody fixes.

## Changing a rule

The house rules live in [their own repository](https://github.com/jliocsar/begone-slop) and arrive here as an ordinary dependency, compiled. There's nothing rule-shaped to edit in this repo: fix it there, publish, and bump the version here.

## Releasing

The binary's version is the CLI package's `version` field, bundled at compile time. The committed value stays `0.0.0`, and the release workflow overwrites it from the tag before building, so pushing a `v*` tag is the whole release.

## Docs

A change to how pie behaves updates the page in `docs/` that describes it, in the same commit.
