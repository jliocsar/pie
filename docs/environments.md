# Environments

An environment is `environments/<name>.toml`: the tools, env vars and tasks a recipe builds on.

```toml
#:schema ../.pie/schema/environment.json
label = "Personal"
tasks = ["up", "dotfiles"]

[tools]
node = "24.22.1"
bun = "latest"
"github:dmtrKovalenko/fff" = { version = "0.10.6", matching = "fff-mcp", bin = "fff-mcp" }

[env]
GH_HOST = "github.int.exe.xyz"
```

| Key       | Default  | What it is                                                 |
| --------- | -------- | ---------------------------------------------------------- |
| `label`   | required | A human name. Never inherited.                             |
| `extends` | none     | One other environment this one builds on.                  |
| `tools`   | `{}`     | mise tools, by mise tool or backend spec.                  |
| `env`     | `{}`     | Env vars every shell and tool on the pod gets.             |
| `tasks`   | `[]`     | [Tasks](tasks.md) to run on every `pod up`, in this order. |

## Tools

A tool's key is anything mise accepts: `node`, `gh`, `github:owner/repo`, `npm:package`. Its value is a version, or a flat table of mise tool options holding one.

Some tools need options to install at all. fff's releases ship a library next to the `fff-mcp` binary, and mise's asset detection picked the library, so its entry needs `matching` and `bin`.

exe.dev preinstalls `claude` and `pi` on every VM, so neither needs to be here.

npm-published MCP servers are the exception to "tools go here". See [Claude](claude.md#mcp-servers).

### Updates

Every pod has mise's tool auto-update on. Before running a tool, mise updates it if its version allows it:

- An exact version, like `"24.22.1"`, never moves.
- A range, like `"24"` or `"lts"`, moves within itself.
- `"latest"` follows every release.

To stop one tool from updating without pinning it, add `auto_update = false` to its options. mise also holds back releases younger than a day, so an update reaches a pod at least a day after it ships.

## Env vars

`[env]` reaches every login shell, and every command run through mise. Never put a secret here: credentials come from [integrations](tags-and-integrations.md). A placeholder a client insists on is fine, like the `x` an S3 client wants for a key the integration signs for.

## Extending another environment

```toml
#:schema ../.pie/schema/environment.json
label = "Work"
extends = "personal"

[tools]
node = "24.22.1"
gcloud = "589.0.0"
```

- `tools` and `env` merge key by key, and the child wins.
- A tool's entry is replaced whole. A child that sets `node` sets all of `node`'s options.
- `tasks` is replaced whole too. Leave it out to inherit the parent's, or set `[]` to clear them.
- `label` is never inherited.
- Chains go as deep as you like. A cycle fails `pie check`.

## Where it lands

The environment becomes `pie.toml` in mise's global `conf.d`. `pod up` adds mise's shims to `~/.profile`, and `mise activate` to `~/.zshrc`, since zsh never reads `~/.profile`. So a login shell gets the tools, the `mise` command and the `[env]` vars.
