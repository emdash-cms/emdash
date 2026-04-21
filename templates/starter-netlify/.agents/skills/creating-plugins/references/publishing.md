# Publishing to the Marketplace

Sandboxed plugins can be published to the EmDash Marketplace for one-click installation from the admin UI.

## Bundle Format

Published plugins are `.tar.gz` tarballs:

| File            | Required | Description                                     |
| --------------- | -------- | ----------------------------------------------- |
| `manifest.json` | Yes      | Metadata extracted from `definePlugin()`        |
| `backend.js`    | No       | Bundled sandbox code (self-contained ES module) |
| `admin.js`      | No       | Bundled admin UI code                           |
| `README.md`     | No       | Plugin documentation                            |
| `icon.png`      | No       | Plugin icon (256x256 PNG)                       |
| `screenshots/`  | No       | Up to 5 screenshots (PNG/JPEG, max 1920x1080)   |

## Package Exports for Bundling

The bundle command uses `package.json` exports to find entrypoints:

```json
{
	"exports": {
		".": { "import": "./dist/index.mjs" },
		"./sandbox": { "import": "./dist/sandbox-entry.mjs" },
		"./admin": { "import": "./dist/admin.mjs" }
	}
}
```

| Export        | Purpose                       | Built as                             |
| ------------- | ----------------------------- | ------------------------------------ |
| `"."`         | Main entry — extract manifest | Externals: `emdash`, `@emdash-cms/*` |
| `"./sandbox"` | Backend code for the sandbox  | Fully self-contained (no externals)  |
| `"./admin"`   | Admin UI components           | Fully self-contained                 |

If `"./sandbox"` is missing, the command looks for `src/sandbox-entry.ts`.

## Build and Publish

```bash
# Bundle only (inspect first)
emdash plugin bundle
tar tzf dist/my-plugin-1.0.0.tar.gz

# Publish (uploads to marketplace)
emdash plugin publish

# Build + publish in one step
emdash plugin publish --build
```

First-time publish authenticates via GitHub device authorization. Token stored in `~/.config/emdash/auth.json` (30-day expiry).

## Validation

The bundle command checks:

- **Size limit** — Total bundle under 5MB
- **No Node.js built-ins** — `backend.js` cannot import `fs`, `path`, etc.
- **Sandbox-incompatible features** — Warns if the plugin declares `portableTextBlocks`, `admin.entry` (React components), or API `routes`, since these require trusted mode
- **Icon dimensions** — 256x256 PNG (warns if wrong)
- **Screenshot limits** — Max 5, max 1920x1080

## Security Audit

Every published version is automatically audited for:

- Data exfiltration patterns
- Credential harvesting via settings
- Obfuscated code
- Resource abuse (crypto mining, etc.)
- Suspicious network activity

Verdict: **pass**, **warn**, or **fail** — displayed on marketplace listing.

## Version Requirements

- Each version must have higher semver than the last
- Cannot overwrite or republish an existing version
- Plugin ID is auto-registered on first publish
