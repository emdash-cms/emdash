---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/admin": patch
---

Unifies plugin capability names under a single `<resource>[.<sub-resource>]:<verb>[:<qualifier>]` formula so capabilities read like RBAC permissions, separates hook-registration permissions from data-access ones for clearer audits, and replaces the overloaded `:any` qualifier with the more conspicuous `:unrestricted`. Old names are still accepted with `@deprecated` warnings; `emdash plugin bundle` and `emdash plugin validate` warn for each deprecated name and `emdash plugin publish` refuses manifests that still use them.

The Cloudflare sandbox bridge and HTTP fetch helper now enforce canonical names (`content:read`, `content:write`, `media:read`, `media:write`, `users:read`, `network:request`, `network:request:unrestricted`). Manifests that still declare legacy names continue to work — the runner normalizes capabilities before passing them into the bridge, so installed plugins with `read:content` resolve to `content:read` and reach the same code path.

| Old                 | New                              |
| ------------------- | -------------------------------- |
| `read:content`      | `content:read`                   |
| `write:content`     | `content:write`                  |
| `read:media`        | `media:read`                     |
| `write:media`       | `media:write`                    |
| `read:users`        | `users:read`                     |
| `network:fetch`     | `network:request`                |
| `network:fetch:any` | `network:request:unrestricted`   |
| `email:provide`     | `hooks.email-transport:register` |
| `email:intercept`   | `hooks.email-events:register`    |
| `page:inject`       | `hooks.page-fragments:register`  |

Existing installs keep working — manifests are normalized at every external boundary and `diffCapabilities` normalizes both sides so version upgrades that only rename do not trigger a "capability changed" prompt. Deprecated names will be removed in the next minor.
