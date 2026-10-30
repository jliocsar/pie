# Commands

Run `pie --help`, or `pie <command> --help`, for the full list of flags.

## pie pod up

```sh
pie pod up [<org>/<repo>]
```

Runs on a pod and applies its recipe. The first run needs the config repo, and later runs remember it. The config repo must be `<org>/<repo>`, whether you pass it or pie remembers it, and anything else fails before pie fetches.

### What it does, in order

1. Reads the VM's tags from exe.dev's reflection integration, and picks the recipe from its `pie-recipe-<name>` tag.
2. Fetches the config repo and resets its copy to the remote's HEAD.
3. Loads the whole config, the same way `pie check` does, and finds the recipe.
4. Checks that the VM carries every tag in the recipe's `tags`.
5. Checks that nothing it's about to write belongs to someone else: an agent, skill or MCP server pie didn't add, or a copied home file pie didn't write.
6. Installs the environment's tools with mise, and writes its `[env]`.
7. Writes the home sets.
8. Runs the environment's tasks, in order.
9. Clones repositories whose directories are missing.
10. Writes Claude's agents, settings, skills and MCP servers.
11. Rewrites pie's block in `~/.claude/CLAUDE.md`.

It ends with `Applied recipe <name> at config commit <sha>.`

Steps 1 to 5 write nothing outside pie's own copy of the config repo, so a missing tag, a broken config or a conflict stops `pod up` before it touches anything else.

### Running it again

`pod up` is how a pod picks up a change. A second run with nothing changed rewrites nothing pie owns, though tasks run every time, which is why they have to be idempotent. Each run:

- removes what the recipe dropped: home files, agents, skills, settings keys, MCP servers and `CLAUDE.md` text
- overwrites edits made on the pod to anything pie owns, so change the config repo instead
- leaves repositories alone once they're cloned

pie records what it owns in manifests under `~/.config/pie/`. Before writing, it saves the old and new lists together, so a run that dies halfway never leaves pie's own files looking like someone else's.

## pie check

```sh
pie check [dir]
```

Validates a config repo checkout, the current directory by default. It loads the config the way `pod up` does, then also checks each TOML file's `#:schema` line and that `.pie/schema` is up to date. See [the config repo](config-repo.md#checking-it).

## pie sync

```sh
pie sync [dir]
```

Rewrites `.pie/schema` from the names on disk, so editors autocomplete them. Run it after adding, renaming or deleting a config file. See [the config repo](config-repo.md#editor-schemas).

## Global flags

| Flag                                  | What it does                                        |
| ------------------------------------- | --------------------------------------------------- |
| `--version`, `-v`                     | Prints pie's version.                               |
| `--log-level <level>`                 | Sets the minimum log level, from `trace` to `none`. |
| `--completions <bash\|zsh\|fish\|sh>` | Prints a shell completion script.                   |
| `--wizard`                            | Asks for a command's arguments one at a time.       |
