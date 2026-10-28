# Installing

## On a pod

```sh
curl -fsSL https://github.com/jliocsar/pie/releases/latest/download/setup.sh | sh -s -- <org>/<repo>
```

The script:

1. Installs mise to `~/.local/bin/mise`, unless it's already there.
2. Installs pie with `mise use --global github:jliocsar/pie@<version>`.
3. Links `/usr/local/bin/pie` to mise's shim. A plain `ssh vm cmd` gets a `PATH` without mise's directories, and the link is what lets `ssh vm pie pod up` work from the laptop.
4. Runs `pie pod up <org>/<repo>`, when you pass one. Without an argument it only installs pie.

If a step fails, the script names it.

| Variable                | Default          | What it does                                                       |
| ----------------------- | ---------------- | ------------------------------------------------------------------ |
| `PIE_VERSION`           | `latest`         | The pie version to install. An exact one, like `0.15.0`, pins pie. |
| `PIE_INSTALL_DIRECTORY` | `/usr/local/bin` | Where the `pie` link goes.                                         |

Pass one through `sh`'s environment:

```sh
curl -fsSL https://github.com/jliocsar/pie/releases/latest/download/setup.sh | PIE_VERSION=0.15.0 sh -s -- <org>/<repo>
```

## Updates

mise updates pie, the same way it updates every other tool on a pod. There's no self-update command.

mise checks for a new version when pie runs, and normally holds back any release younger than a day. The setup script exempts pie from that wait. mise also caches version lists, so a pod can still trail a release by up to an hour.

To update right away, re-run the setup line. It asks GitHub directly, skipping mise's caches, and installs the newest release. An exact `PIE_VERSION` never updates.

A pod installed before v0.14.0 has a plain binary instead of a mise install. Re-running the setup line once moves it to mise.

## On the laptop

The laptop only needs pie for `check` and `sync`. Install it with mise:

```sh
mise use --global github:jliocsar/pie@latest
```

mise holds back a release younger than its `minimum_release_age`, a day by default, so `mise up` won't install a new pie until then. To skip the wait once:

```sh
MISE_MINIMUM_RELEASE_AGE=0 mise up github:jliocsar/pie
```

## Releases

Pushing a `v*` tag to the pie repo builds `pie-linux-x64` and `pie-linux-arm64`, and attaches both to the release along with `setup.sh`.
