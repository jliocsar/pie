# Repositories

A recipe's `repositories` clone into `~/workspace`:

```toml
repositories = [
  "my-org/app",
  { repo = "my-org/infra", dir = "infra" },
  { repo = "other-org/api", integration = "other-org-git" },
]
```

| Form                    | Clones into                | Through                          |
| ----------------------- | -------------------------- | -------------------------------- |
| `"<org>/<repo>"`        | `~/workspace/<org>/<repo>` | exe.dev's GitHub integration     |
| `{ repo, dir }`         | `~/workspace/<dir>`        | exe.dev's GitHub integration     |
| `{ repo, integration }` | `~/workspace/<org>/<repo>` | the named http-proxy integration |

A repository clones only when its directory is missing, and pie never pulls it. Your branches and work in progress are safe across `pod up`. Dropping a repository from a recipe leaves its checkout on the pod.

## Through the GitHub integration

Without `integration`, pie clones over https through exe.dev's GitHub App integration, which authenticates by the VM's tags. Attach a GitHub integration that reaches the repo to `tag:pie-recipe-<recipe>`, or to a tag in the recipe's [`tags`](tags-and-integrations.md#recipe-tags) when several recipes share it.

## Through an http-proxy integration

For an org that won't install the GitHub App, name an http-proxy integration instead. pie clones from `https://<integration>.int.exe.xyz/<org>/<repo>.git`, and the proxy adds a token as a basic auth header:

```sh
ssh exe.dev "integrations add http-proxy --name other-org-git \
  --target https://github.com \
  --header 'Authorization:Basic <base64 of x-access-token:PAT>' \
  --attach tag:pie-recipe-<recipe>"
```

The PAT is a fine-grained token with Contents: read on the repos. If the proxy answers but a repo gives 403 or 404, the token can't see that repo: the org hasn't approved the token yet, or the token doesn't cover the repo.

Either way, no credential lands on the pod, and the clone's remote stays on the integration host, so later fetches go through it too.

A clone that fails names the repo, the integration, and the tag it should be attached to.
