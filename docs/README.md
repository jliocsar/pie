# pie docs

pie turns exe.dev VMs into Claude Code / Pi pods. A recipe in a config repo says what a pod gets, and each pod applies its own recipe with `pie pod up`. There's no server.

New to pie? Read [getting started](getting-started.md) first. After that, read the page for whatever you're editing.

- [Getting started](getting-started.md): the laptop, the pod and the config repo, then a first pod end to end.
- [Installing](installing.md): the setup script, picking a version, and how pie updates itself.
- [The config repo](config-repo.md): its layout, how a pod reads it, editor schemas, and the push gate.
- [Recipes](recipes.md): every key a recipe takes.
- [Environments](environments.md): tools, env vars, `extends`, and tool auto-updates.
- [Tasks](tasks.md): the scripts a pod runs on every `pod up`, and the rules they follow.
- [Repositories](repositories.md): what a pod clones, and the integration for orgs without the GitHub App.
- [Home sets](home-sets.md): dotfiles, copy vs append, and the paths pie keeps for itself.
- [Claude](claude.md): agents, settings, `CLAUDE.md` text, skills and MCP servers.
- [Tags and integrations](tags-and-integrations.md): how a VM gets its recipe and its credentials.
- [Commands](commands.md): `pod up` step by step, `check` and `sync`.
- [Troubleshooting](troubleshooting.md): every error pie prints, and its fix.
- [Contributing](contributing.md): working on pie itself.
