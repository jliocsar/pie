# bun:test

`@effect/vitest` needs vitest. Under `bun test` there is no `it.effect`, `layer()` or automatic `TestClock`/`TestConsole`, so a file builds its own runtime.

## Runtime per file

```ts
import * as BunServices from "@effect/platform-bun/BunServices"
import { afterAll, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as ManagedRuntime from "effect/ManagedRuntime"

const runtime = ManagedRuntime.make(Profiles.layer.pipe(Layer.provideMerge(BunServices.layer)))

afterAll(() => runtime.dispose())

describe("Profiles", () => {
  test("loads a profile", () =>
    runtime.runPromise(
      Effect.gen(function*() {
        const profiles = yield* Profiles
        expect(yield* profiles.load(profileName)).toEqual(expected)
      })
    ))
})
```

- DO return the `runPromise` promise from `test`, so a failure fails the test.
- DO `Effect.scoped` anything that acquires, since nothing wraps the test in a scope for you.
- DON'T use `mock.module`: `begone-slop/no-module-mocking` rejects it, and an open `layer` makes it unnecessary.

## Fakes

A service's `layer` leaves its dependencies open (see `../services/layers.md`), so a test provides fakes of exactly those:

```ts
import * as HttpClient from "effect/http/HttpClient"
import * as HttpClientResponse from "effect/http/HttpClientResponse"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as TestConsole from "effect/testing/TestConsole"

const ReflectionLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ tags: [] }))))
)

const NoProcessesLayer = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() => Effect.die("unexpected spawn"))
)

const TagsUnderTest = Tags.layer.pipe(Layer.provide(ReflectionLayer))
```

- A fake service that records calls keeps them in a `Ref` service, `provideMerge`d beside it so the test can read it back.
- `TestConsole.layer` replaces `Console.Console`; read what was printed with `TestConsole.logLines` / `TestConsole.errorLines`.
- `TestClock` is not installed for you: provide `TestClock.layer()` where a test needs virtual time.

### Custom fakes: members added at 4.1

These constructors take the whole service, so a fake written earlier stops compiling.

| Constructor | Must now supply | Or use |
| --- | --- | --- |
| `FileSystem.make` | `readDirectoryEntries`, `lstat` | `FileSystem.layerNoop(partial)`: most members you leave out fail with NotFound, but `exists` returns false, `remove` succeeds, and `makeDirectory` and `makeTemp*` die |
| `Terminal.make` | `size`: `Effect.die("unused")` when nothing reads it | |
| `KeyValueStore.make` | `keys` | `KeyValueStore.layerMemory` |

## Child processes

`ChildProcess.make` builds a command in one of three forms. No form runs a shell unless you ask for one.

| Form | Behaviour |
| --- | --- |
| `ChildProcess.make("git", ["commit", "-m", message], { cwd })` | Every argument is literal. DO use it for anything computed. |
| ``ChildProcess.make`git commit -m ${message}` `` | `${value}` is inserted literally as one argument, an array spreads, quotes group. Shell syntax in the text (`\|`, `$HOME`, `*`, `~`) throws `CommandLineError` at `make`. |
| ``ChildProcess.make({ shell: true })`ls \| wc -l` `` | The text is a shell script, and no `${}` is allowed. |

- `Redacted` arguments work in the array and template forms, but not as the program name. `CommandLine.display` prints `<redacted>`, and `CommandLine.join` includes the value, so log with `display`.
- DON'T build a pipeline with a shell for a pipe: `ChildProcess.pipeTo` joins two commands.

The process fake answers every spawn with a handle and records the command line:

```ts
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import * as CommandLine from "effect/process/CommandLine"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"

const spawned: Array<string> = []

const FakeSpawner = ChildProcessSpawner.make((command) =>
  Effect.sync(() => {
    if (ChildProcess.isStandardCommand(command)) {
      spawned.push(CommandLine.display([command.command, ...command.args]))
    }
    const output = Stream.make(new TextEncoder().encode("hello\n"))
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: output,
      stderr: Stream.empty,
      all: output,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty
    })
  })
)

const FakeSpawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, FakeSpawner)
```

`FakeSpawner.string(command)` returns `"hello\n"` and `FakeSpawner.exitCode(command)` returns `0`, as they would over a real process. For an API or an MCP server, see `in-memory-servers.md`.
