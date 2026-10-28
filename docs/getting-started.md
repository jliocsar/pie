# Getting started

## The pieces

- **The config repo** is a git repo of TOML, Markdown and scripts. It holds every recipe and everything they name. pie has no server, so this repo is the whole source of truth.
- **A pod** is an exe.dev VM that carries two tags: `pie`, and `pie-recipe-<name>` naming `recipes/<name>.toml`. On the pod, `pie pod up` reads those tags, fetches the config repo and applies the recipe.
- **The laptop** edits the config repo, checks it with `pie check`, and pushes it. It never applies a recipe itself.

Secrets never live on a pod. exe.dev integrations attach to the VM's tags and add credentials at the network edge, so a pod can clone private repos and call authenticated APIs without holding a token. See [tags and integrations](tags-and-integrations.md).

## A first pod

### 1. Write a config repo

The smallest config is one recipe and the environment it builds on:

```toml
#:schema ../.pie/schema/recipe.json
label = "Dev"
environment = "base"

repositories = ["my-org/my-app"]
```

```toml
#:schema ../.pie/schema/environment.json
label = "Base"

[tools]
node = "24.22.1"
```

Save them as `recipes/dev.toml` and `environments/base.toml`. Then, from the repo's root:

```sh
pie sync    # writes .pie/schema, so editors can check the files
pie check   # loads the config the way a pod will
```

Commit everything, `.pie/schema` included, and push it to GitHub.

### 2. Give pods access to it

In exe.dev, add a GitHub integration that can read the config repo, and attach it to `tag:pie`. Every pod shares this one integration.

The recipe above also clones `my-org/my-app`, so that repo needs a GitHub integration too. Attach it to `tag:pie-recipe-dev` if only this recipe needs it.

### 3. Create the VM

```sh
ssh exe.dev new --name my-pod --tag pie,pie-recipe-dev
```

### 4. Install pie and apply the recipe

```sh
ssh my-pod.exe.xyz 'curl -fsSL https://github.com/jliocsar/pie/releases/latest/download/setup.sh | sh -s -- my-org/my-config'
```

That installs pie, then runs `pie pod up my-org/my-config`. pie remembers the repo, so later runs need no argument.

### 5. Log into Claude

`ssh my-pod.exe.xyz`, run `claude` and log in. It's interactive, and it's the one credential that lives on a pod.

## Changing a pod

Edit the config repo, run `pie sync && pie check`, push, then re-apply on the pod:

```sh
ssh my-pod.exe.xyz pie pod up
```

A pod only sees pushed commits. Every `pod up` resets its copy of the config repo to the remote, so nothing local survives. See [the config repo](config-repo.md).
