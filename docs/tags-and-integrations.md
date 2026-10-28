# Tags and integrations

## How a VM gets its recipe

Every pod carries two exe.dev tags:

- `pie`, which every pod shares.
- `pie-recipe-<name>`, which picks `recipes/<name>.toml`.

`pod up` reads the VM's tags from exe.dev's reflection integration on every run. A VM with no recipe tag, or more than one, fails with the `ssh exe.dev tag` command that fixes it. Retag a VM and run `pod up` again to switch its recipe.

pie never creates VMs, tags or integrations. You make them in exe.dev, from the laptop.

## Where credentials come from

A pod holds no secrets. exe.dev integrations add credentials at the network edge: a request to `https://<integration>.int.exe.xyz` leaves the VM without a token and arrives at the service with one.

An integration attaches to one exact tag, and exe.dev has no tag globs. So which tag an integration goes on decides which pods get it:

| Attach to                                        | When                                                                |
| ------------------------------------------------ | ------------------------------------------------------------------- |
| `tag:pie`                                        | Every pod needs it, like the config repo's GitHub integration.      |
| `tag:pie-recipe-<name>`                          | Only that recipe needs it, like its repos or an MCP server's token. |
| a tag of its own, listed in each recipe's `tags` | Several recipes share it.                                           |

The one credential on a pod is Claude's own login, done by hand on the box.

## Recipe tags

A recipe can require more tags:

```toml
tags = ["work-gh", "work-gcp"]
```

That lets an integration several recipes share attach once, to `work-gh`, instead of to each recipe's tag.

pie still never writes a tag, since the VM holds no exe.dev credentials. Give a new VM every tag when you create it:

```sh
ssh exe.dev new --name my-pod --tag pie,pie-recipe-work,work-gh,work-gcp
```

On an existing VM, `pod up` fails before changing anything when a tag is missing, and prints the line that adds it:

```sh
ssh exe.dev tag my-pod work-gcp
```

`pie check` can't see a VM, so it only checks that each entry is a valid exe.dev tag name, and that it isn't `pie` or a `pie-recipe-` tag. The VM has those already, and another recipe's tag would give it two recipes.
