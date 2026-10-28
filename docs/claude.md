# Claude

A recipe's Claude config lives under `[claude]`, plus `skills` and `mcp` at the top level:

```toml
skills = ["handoff"]
mcp = ["fff", "docs"]

[claude]
agents = ["explore"]
settings = "default"
claude_md = ["tigris"]
```

pie owns only what it wrote. If an agent, a skill or a user MCP server with the same name already exists and pie didn't write it, `pod up` fails before changing anything, and says what to move or remove.

## Agents

`claude/agents/<name>.md` lands in `~/.claude/agents/`. Its frontmatter needs a non-empty `name` and a `description`. Every other field passes through untouched.

```markdown
---
name: explore
description: Read-only codebase search.
---

You search the codebase and report what you find...
```

## Settings

`claude/settings/<name>.json` is a JSON object, and a recipe picks one. Its keys merge into `~/.claude/settings.json` key by key, over whatever you set by hand.

pie remembers which keys it wrote, so a key dropped from the file is removed on the next `pod up`, and every other key is left alone. The file is only rewritten when the merge changes it.

## CLAUDE.md

`claude/claude_md/<name>.md` adds text to `~/.claude/CLAUDE.md`. pie keeps one marked block in that file:

```text
<!-- >>> pie >>> -->
## pie

This VM is a pie pod: recipe `work` from `my-org/my-config`.
...

## Tigris bucket

...
<!-- <<< pie <<< -->
```

The block always opens with pie's own `## pie` text, which tells Claude it's on a pod. The recipe's `claude_md` files follow in the order listed, each trimmed, with one blank line between them. An empty one drops out.

Start each file with a `##` heading, the same level as pie's.

Every `pod up` rewrites the whole block, so a file dropped from the recipe loses its text on the next run. Anything outside the markers is yours, and pie never touches it.

A file can't contain the block's end marker, `<!-- <<< pie <<< -->`. pie finds the end of its block by the first end marker after the start, so one inside a file would cut the block short, and every later `pod up` would write the rest again.

## Skills

`skills/<name>/` ships whole to `~/.claude/skills/<name>/`. `SKILL.md`'s frontmatter needs `name` and `description`, and `name` must match the directory, as the Agent Skills spec requires. Other fields pass through.

To vendor a third-party skill, use the `skills` CLI, which records each one's source and hash in `skills-lock.json`. Edit a vendored skill upstream: a local edit is lost on the next update.

## MCP servers

`mcp/<name>.toml` is one server, added at Claude's user scope under that name. A stdio server:

```toml
#:schema ../.pie/schema/mcp.json
command = "fff-mcp"
args = []
```

An HTTP server:

```toml
#:schema ../.pie/schema/mcp.json
url = "https://mcp.example.com/mcp"
```

A stdio server's command has to be on the pod, which usually means a tool in the recipe's environment.

An npm-published server runs through `npx` with a pinned version, rather than as an `npm:` tool. mise asks before installing an npm package with under 1000 weekly downloads, and `pod up` runs mise with stdin closed, so that install aborts. `node` in the environment is what puts `npx` on the pod:

```toml
command = "npx"
args = ["-y", "effect-mcp@0.1.16"]
```

No secret goes in an MCP file. A server that needs one goes through an exe.dev http-proxy integration, which adds the auth at the network edge. pie can't tell when that integration is missing, so the server just fails inside Claude.

pie adds and removes servers with `claude mcp add-json` and `claude mcp remove`, and never writes `~/.claude.json` itself: that's Claude's live state, rewritten by every running session. A second `pod up` of the same recipe runs no `claude` command at all.
