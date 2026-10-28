# Tasks

A task is an executable script, `tasks/<name>`, that an environment lists. Tasks run on every `pod up`, in the order listed, after the tools and home sets and before the repositories clone.

```sh
#!/bin/sh
set -eu

command -v zsh >/dev/null 2>&1 || { sudo apt-get update -q && sudo apt-get install -y zsh; }
```

Reach for a task only when nothing declarative covers it. A tool goes in an environment's `[tools]`, a dotfile in a [home set](home-sets.md), a repo in `repositories`. Tasks are for the rest: apt packages, the login shell, cloning something outside `~/workspace`.

## Rules

- **Idempotent.** A task runs on every `pod up`, so it checks before it acts: `[ -d "$dir" ] || git clone …`, never a bare `git clone`.
- **No prompts.** Stdin is closed, because `pod up` often runs under `curl | sh`, where stdin is the setup script. Anything that asks has to be told not to: `apt-get install -y`.
- **A shebang and `set -eu`.** pie writes the copy it runs as executable, so the file's mode on disk doesn't matter, but the shebang does.
- **Nothing beside it.** A task runs from a temporary copy, through `mise exec`, with `~` as its working directory. The environment's tools are on `PATH`, but the config repo isn't, so a task can't read other files from it.
- **Nothing in `~/workspace` yet** on a pod's first run, since repositories clone after tasks.

`sudo` works without a password. A task that exits non-zero stops `pod up`, and pie names the command that failed.
