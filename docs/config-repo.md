# The config repo

## Layout

Each kind of thing has one directory, and a file's name is its name. A recipe refers to everything else by name, never by path.

```
recipes/<name>.toml            a recipe, one per pie-recipe-<name> tag
environments/<name>.toml       tools, env vars and tasks a recipe builds on
tasks/<name>                   a script an environment runs on every pod up
home/<name>/                   a home set: a tree mirroring ~
claude/agents/<name>.md        a Claude subagent
claude/settings/<name>.json    keys merged into ~/.claude/settings.json
claude/claude_md/<name>.md     text added to pie's block in ~/.claude/CLAUDE.md
skills/<name>/SKILL.md         a skill; the whole directory ships
mcp/<name>.toml                one MCP server
.pie/schema/*.json             editor schemas, written by pie sync
```

A recipe's name has to fit an exe.dev tag after `pie-recipe-`, so it uses only `a-z`, `0-9`, `_` and `-`. Other names have no hard rule, but sticking to the same set costs nothing.

Recipes and environments are split because a toolchain is shared and a recipe isn't. Two recipes can build on one environment and differ only in repositories, Claude config and dotfiles.

## How a pod reads it

The first `pie pod up <org>/<repo>` on a pod remembers the repo, so later runs need no argument.

The pod keeps its copy of the config repo in its cache directory. Every `pod up` fetches it and hard-resets it to the remote's HEAD. That copy is a cache nobody edits, and a reset can't get stuck on a conflict.

So only pushed commits reach a pod. Nothing local to the laptop, and nothing edited in the pod's copy, survives a `pod up`.

The fetch goes through exe.dev's GitHub integration, attached to `tag:pie`. See [tags and integrations](tags-and-integrations.md).

## Editor schemas

Every TOML file starts with a `#:schema` line pointing at its JSON schema:

```toml
#:schema ../.pie/schema/recipe.json
```

`pie sync` writes those schemas from pie's own, with an enum of the names on disk wherever a file names another. An editor using them, through taplo or Even Better TOML, autocompletes names and flags a typo or an unknown key as you type.

Run `pie sync` after adding, renaming or deleting any file a recipe or environment can name. Sync only reads file and directory names, so it works on a config that doesn't load yet. Commit `.pie/schema` with the change that needed it.

## Checking it

```sh
pie check
```

`pie check` runs the same loader `pod up` runs, so a config that passes it is one every pod can load. On top of that, it fails when a TOML file doesn't start with its `#:schema` line, or when `.pie/schema` is out of date with the names on disk.

### Before every push

A mise task in the config repo's `mise.toml` runs the check:

```toml
[tasks.pre-push]
usage = 'arg "[git_arguments]" var=#true'
run = "pie check"
```

The `usage` line takes the arguments git passes a hook, which mise would otherwise append to `pie check`. Turn the hook on once per clone:

```sh
mise generate git-pre-commit --write --hook pre-push --task pre-push
```

A `mise.toml` holding only tasks runs without `mise trust`, so the config repo stays quiet on a pod that clones it.

### In CI

```yaml
name: check

on: push

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - run: curl -fsSL https://github.com/jliocsar/pie/releases/latest/download/setup.sh | sh
        env:
          GITHUB_TOKEN: ${{ github.token }}
      - run: pie check
```
