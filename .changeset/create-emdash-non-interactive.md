---
"create-emdash": minor
---

Adds non-interactive mode to `create-emdash` for CI / scripted scaffolding (#711). Pass `--template`, `--platform`, `--pm`, `--install`/`--no-install`, `--yes`, and `--force` to skip prompts; partial flag use only prompts for unset fields. Interactive flow is unchanged when no flags are supplied.

- `--template <key>` accepts a bare template (`blog | starter | marketing | portfolio`) or the combined form `<platform>:<key>` (e.g. `cloudflare:blog`).
- `--pm <key>` (alias `--package-manager`) selects the package manager.
- `--yes` / `-y` accepts defaults for any unset field (cloudflare, blog, detected pm, `my-site` for an unset name).
- `--force` is required alongside `--yes` to overwrite a non-empty target directory; without it, the CLI refuses rather than silently clobbering files.
- `--help` / `-h` prints usage. Unknown flags fail loudly so typos don't silently drop into interactive mode.
- An extra positional argument (e.g. `npm create emdash my blog` with a space instead of a hyphen) is now rejected as a likely typo.

No new dependencies — built on `node:util`'s `parseArgs`.
