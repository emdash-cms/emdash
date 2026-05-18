---
"@emdash-cms/plugin-cli": patch
---

Renames the `--aggregator` flag on `search` and `info` to `--registry-url` for consistency with the `EMDASH_REGISTRY_URL` env var and the rest of the user-facing surface. Internally the override still selects the aggregator service to query — the rename only affects what users type.

Old:

```sh
emdash-plugin search "image" --aggregator https://registry.example.com
```

New:

```sh
emdash-plugin search "image" --registry-url https://registry.example.com
```
