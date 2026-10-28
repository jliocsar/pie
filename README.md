<div align="center">

<img src="https://oldschool.runescape.wiki/images/Fish_pie_detail.png" width="128" />

<h1>pie</h1>

<i>A recipe manager for exe.dev VMs.</i>

</div>

pie turns exe.dev VMs into Claude Code / Pi pods. A recipe in a config repo says what a pod gets:
tools, env vars, dotfiles, repositories, and Claude's agents, settings, skills and MCP servers. Each
pod applies its own recipe, and there's no server.

A VM tagged `pie` and `pie-recipe-<name>` becomes a pod from `recipes/<name>.toml`:

```sh
curl -fsSL https://github.com/jliocsar/pie/releases/latest/download/setup.sh | sh -s -- <org>/<repo>
```

```sh
pie pod up [<org>/<repo>]   # on a pod: apply its recipe
pie check [dir]             # validate a config checkout
pie sync [dir]              # rewrite .pie/schema from the names on disk
```

Read [the docs](docs/README.md), starting with [getting started](docs/getting-started.md). Working
on pie itself? See [contributing](docs/contributing.md).
