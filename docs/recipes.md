# Recipes

A recipe is `recipes/<name>.toml`, and a VM tagged `pie-recipe-<name>` gets it.

```toml
#:schema ../.pie/schema/recipe.json
label = "Work"
environment = "work"
tags = ["work-gh"]

repositories = [
  "my-org/app",
  { repo = "my-org/infra", dir = "infra" },
  { repo = "other-org/api", integration = "other-org-git" },
]

home = ["git", { name = "zsh", mode = "append" }]
skills = ["handoff"]
mcp = ["fff"]

[claude]
agents = ["explore"]
settings = "default"
claude_md = ["work"]
```

| Key                | Default  | What it is                                                                                              |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------- |
| `label`            | required | A human name for the recipe.                                                                            |
| `environment`      | required | The [environment](environments.md) it builds on: its tools, env vars and tasks.                         |
| `tags`             | `[]`     | More exe.dev tags its VMs must carry. See [tags and integrations](tags-and-integrations.md).            |
| `repositories`     | `[]`     | Repos cloned into `~/workspace`. See [repositories](repositories.md).                                   |
| `home`             | `[]`     | [Home sets](home-sets.md): dotfiles that land in `~`.                                                   |
| `skills`           | `[]`     | Skills from `skills/`. See [Claude](claude.md#skills).                                                  |
| `mcp`              | `[]`     | MCP servers from `mcp/`. See [Claude](claude.md#mcp-servers).                                           |
| `claude.agents`    | `[]`     | Subagents from `claude/agents/`. See [Claude](claude.md#agents).                                        |
| `claude.settings`  | none     | One settings file from `claude/settings/`, a name rather than a list. See [Claude](claude.md#settings). |
| `claude.claude_md` | `[]`     | Text from `claude/claude_md/`, in this order. See [Claude](claude.md#claudemd).                         |

Every name points at a file in the config repo, and `pie check` fails on one that doesn't exist.

Recipes don't extend each other. Two recipes that share most of a setup share an environment instead.

Dropping something from a recipe removes it from the pod on the next `pod up`. A repository is the exception: its checkout stays.

## Switching a pod's recipe

Retag the VM, then run `pod up` again:

```sh
ssh exe.dev tag -d my-pod pie-recipe-dev
ssh exe.dev tag my-pod pie-recipe-work
ssh my-pod.exe.xyz pie pod up
```
