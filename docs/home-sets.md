# Home sets

A home set is a directory, `home/<name>/`, that mirrors `~`. `home/shell/.config/starship.toml` lands on `~/.config/starship.toml`. A recipe's `home` list picks the sets:

```toml
home = ["shell", { name = "zsh", mode = "append" }]
```

## Copy

A bare name copies each file. pie owns the whole file, overwrites it on every `pod up`, and fails if a file it didn't write is already there.

## Append

`{ name, mode = "append" }` keeps the existing file and adds the set's file inside a marked block:

```sh
# >>> pie: home/zsh >>>
...
# <<< pie: home/zsh <<<
```

Each `pod up` replaces only what's between the markers. Use append for any file a fresh VM already has.

## Rules

- `.profile` and `.zshrc` are append-only, because pie adds its own mise lines to both.
- Two sets can write the same file only when both append.
- Some paths pie writes itself, and no set can touch them: `.claude/`, `.claude.json`, `.config/mise/`, `.config/pie/`, `.cache/pie/`, `.local/bin/pie`, `.local/bin/mise`, `.local/share/mise/` and `workspace/`. Claude config goes through the recipe's [`claude` keys](claude.md) instead.

`pie check` names any set that breaks a rule.

Dropping a file or a set removes it from the pod on the next `pod up`. pie keeps a manifest in `~/.config/pie/` of what it wrote, which is how it knows what to remove and what isn't its own.
