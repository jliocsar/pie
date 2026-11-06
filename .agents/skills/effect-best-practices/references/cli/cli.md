# CLI

`effect/cli/*`: `Command`, `Flag`, `Argument`, `CliOutput`, `CliError`. `cli/Command` is `@stability unstable`, so a minor release can break it: pin `effect` exactly.

| Topic | DO | DON'T |
| --- | --- | --- |
| Entry | `Command.run(cli, { version })`, which reads the arguments from `Stdio` | parsing `process.argv` |
| One value | `Argument.withSchema` / `Flag.withSchema` over a branded schema (see `../schema/boundaries.md`) | re-validating in the handler |
| A rule across flags | `Command.validate` | checking in the handler, where help isn't shown |
| Negation | `Flag.withNegation("skip-verify")` replaces `--no-verify`; `Flag.withoutNegation` removes it | a second flag for the opposite |
| Services | wire at the edge; `Command.provide(layer)` when one subcommand alone needs a layer | providing inside a service's own layer |
| Output | `Console.log` in handlers; `CliOutput.layerPresenter` to change help and errors | `console.log`; catching `CliError` to reprint it |
| Tests | `Command.runWith(cli, { version })(args)` over fakes | spawning the compiled binary |

## A command

```ts
import * as BunRuntime from "@effect/platform-bun/BunRuntime"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Argument from "effect/cli/Argument"
import * as CliError from "effect/cli/CliError"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

const Target = Schema.String.check(Schema.isPattern(/^[a-z]+$/)).pipe(Schema.brand("Target"))

const download = Command.make(
  "download",
  {
    target: Argument.String("target").pipe(Argument.withSchema(Target)),
    useApi: Flag.Boolean("use-api").pipe(Flag.withDefault(false)),
    useDocker: Flag.Boolean("use-docker").pipe(Flag.withDefault(false)),
    verify: Flag.Boolean("verify").pipe(Flag.withDefault(true), Flag.withNegation("skip-verify")),
    region: Flag.String("region").pipe(Flag.withAlias("r"), Flag.optional)
  },
  Effect.fn("download")(function*({ target, verify }) {
    yield* Console.log(`Downloading ${target}, verify: ${verify}`)
  })
).pipe(
  Command.validate(({ useApi, useDocker }) =>
    useApi && useDocker
      ? Effect.fail(new CliError.ValidationError({ message: "--use-api and --use-docker are mutually exclusive" }))
      : Effect.void
  ),
  Command.withDescription("Download a target")
)

Command.run(download, { version: "1.0.0" }).pipe(Effect.provide(BunServices.layer), BunRuntime.runMain)
```

- A command needs `FileSystem | Path | Terminal | ChildProcessSpawner | Stdio` (`Command.Environment`), all of it in `BunServices.layer`.
- `Command.validate` sees what the handler sees, defaults applied. Several run in order and stop at the first failure.
- A failed `validate` or a value its schema rejects prints help to the console and the error to the error console, then fails with `CliError.ShowHelp`.
- `validate` placed after `withSharedFlags` sees the shared flags; placed after `withSubcommands` it also runs for the subcommands.
- Subcommands: `Command.withSubcommands([a, b])`. A subcommand reads the parent's `Command.withSharedFlags` flags with `yield* parent`. The parent's own config flags don't reach it, and are rejected before the subcommand.

## Output

`CliOutput.Presenter` receives every `Help`, `Version` and `InvalidInvocation`. Provide one to change what they print, delegating to `defaultPresenter` for the rest:

```ts
const ErrorsWithoutHelp = CliOutput.layerPresenter({
  present: (event) =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        Help: CliOutput.defaultPresenter.present,
        Version: CliOutput.defaultPresenter.present,
        InvalidInvocation: Effect.fn("ErrorsWithoutHelp.invalidInvocation")(function*({ errors }) {
          const formatter = yield* CliOutput.Formatter
          yield* Console.error(formatter.formatErrors(errors))
        })
      })
    )
})
```

- It doesn't cover `--completions`, the wizard, or `CliError.userMessage`.
- The run still fails with `CliError.ShowHelp`; the presenter changes only the output.

## Testing

`Command.runWith` takes the arguments directly, so a test provides the environment as fakes and reads the console back. `Terminal.make` needs `size` since 4.1 (see `../testing/bun-test.md`).

```ts
const CliTestLayer = Layer.mergeAll(
  FileSystem.layerNoop({}),
  Path.layer,
  Stdio.layerTest({}),
  TestConsole.layer,
  Layer.succeed(
    Terminal.Terminal,
    Terminal.make({
      columns: Effect.succeed(80),
      rows: Effect.succeed(24),
      size: Effect.die("unused"),
      readInput: Effect.die("unused"),
      readLine: Effect.die("unused"),
      display: () => Effect.void
    })
  ),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.make(() => Effect.die("unused")))
)

const prints = (args: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    yield* Command.runWith(download, { version: "1.0.0" })(args)
    return yield* TestConsole.logLines
  }).pipe(Effect.provide(CliTestLayer))
```

- Assert a rejection with `Effect.exit` and `TestConsole.errorLines`: the failure is `CliError.ShowHelp`, and the message is in the error lines.
- `{ renderErrors: false }` keeps the failure and skips the error text. Help still prints.
