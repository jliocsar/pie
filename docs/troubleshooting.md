# Troubleshooting

Every pie error says what's wrong and, where it can, the fix. This page groups them by when they show up.

## Tags

| Error says                                                         | Fix                                                                                    |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| This VM has no `pie-recipe-<recipe>` tag                           | `ssh exe.dev tag <vm> pie-recipe-<recipe>` from the laptop.                            |
| This VM has more than one recipe tag                               | Keep one: `ssh exe.dev tag -d <vm> <tag>`.                                             |
| Recipe X needs this VM to carry …                                  | Run the `ssh exe.dev tag` line it prints, then `pie pod up` again.                     |
| This VM is tagged for recipe X, but `recipes/X.toml` doesn't exist | Add the recipe and push it, or retag the VM.                                           |
| pie reads this VM's details from … and that failed                 | `pod up` only runs on exe.dev VMs, which get the reflection integration automatically. |

## The config repo and repositories

| Error says                                                | Fix                                                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| pie doesn't know this VM's config repo yet                | Run `pie pod up <org>/<repo>` once.                                                                                      |
| pie couldn't reach X through exe.dev's github integration | Attach a GitHub integration that reaches the repo to the tag it names.                                                   |
| pie couldn't reach X through exe.dev's Y integration      | Check that Y is attached to the tag it names, and that its token can read the repo. See [repositories](repositories.md). |
| `git … exited with …`                                     | A git command failed for another reason. Its output is in the message.                                                   |

An MCP server that fails inside Claude, with nothing from pie, usually needs an http-proxy integration pie can't see. See [Claude](claude.md#mcp-servers).

## The config itself

These show up in `pie check` and in `pod up`.

| Error says                                      | Fix                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------- |
| X doesn't parse                                 | Fix the TOML or JSON syntax it points at.                                    |
| X is invalid                                    | A key or value is wrong. The message names the path, like `["tags"][0]`.     |
| X lists Y "Z", but … doesn't exist              | Add the file, or fix the name.                                               |
| X is named "A", but its path names it "B"       | Make the frontmatter `name` match the file or directory.                     |
| X has no frontmatter                            | Start the file with a `---` block holding at least `name` and `description`. |
| X extends itself through …                      | Break the `extends` cycle.                                                   |
| X can't name a recipe                           | Rename the recipe file using only `a-z`, `0-9`, `_` and `-`.                 |
| X would land on ~/Y, which pie writes itself    | Move it out of the home set. Claude config goes through the recipe.          |
| X copies ~/Y … it can only be appended to       | List the set as `{ name = "…", mode = "append" }`.                           |
| X lists home sets A and B, which both write ~/Y | Make both sets append, or move the file into one.                            |

Only `pie check` reports these:

| Error says                               | Fix                                                       |
| ---------------------------------------- | --------------------------------------------------------- |
| X doesn't start with `#:schema …`        | Make that line the file's first.                          |
| X is out of date with the config's names | Run `pie sync`.                                           |
| X has no recipes/*.toml                  | Run `pie check` from a config checkout, or pass its path. |

## Applying a recipe

| Error says                                   | Fix                                                                                                                                                            |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| X already exists, and pie didn't write it    | Move it out of the way, then `pie pod up` again. A home file can also switch its set to append.                                                                |
| Claude already has a user MCP server named X | `claude mcp remove --scope user X`, then `pie pod up` again.                                                                                                   |
| `<mise command>` exited with …               | A tool failed to install, or a task failed. The command is in the message, and mise's output is above it.                                                      |
| X isn't the JSON pie expected                | A JSON file pie reads on the pod, like `~/.claude/settings.json` or one of its manifests in `~/.config/pie/`, is broken. Fix it, or remove it if pie wrote it. |
