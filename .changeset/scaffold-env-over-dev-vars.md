---
"create-emdash": patch
---

Scaffold local secrets into `.env` for every platform, including Cloudflare — previously Cloudflare projects got `.dev.vars`.

Since August 2025, Wrangler and the Cloudflare Vite plugin read `.env` files in local development, so there's no longer a reason to split Node (`.env`) and Workers (`.dev.vars`). New projects now write `EMDASH_ENCRYPTION_KEY` to a single `.env` file regardless of platform, matching the dotenv convention most developers already expect.

**This is a deliberate, pre-1.0 hard switch away from `.dev.vars`.** It's called out as a minor bump rather than a patch because the scaffolded file changes name and the surrounding docs/guidance change with it.

**Backwards compatibility / upgrade notes:**

- Existing projects are unaffected — a `.dev.vars` you already have keeps working; Wrangler still reads it.
- Wrangler loads **either** `.dev.vars` **or** `.env`, never both: if a `.dev.vars` file is present its values win and `.env` is ignored entirely. If you migrate an existing project to `.env`, move your secrets across and delete `.dev.vars`, otherwise the new `.env` is silently shadowed.
- When scaffolding into a directory that still contains a `.dev.vars`, `create-emdash` now prints a warning explaining the shadowing rule so the encryption key actually loads.

`emdash secrets generate --write` already accepted any path and is unchanged; only the documented/suggested target moves to `.env`.
