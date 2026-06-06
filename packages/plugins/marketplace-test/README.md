# Marketplace Test Plugin

End-to-end test plugin for the EmDash marketplace publish and audit pipeline.

## What it does

- Hooks into `content:beforeSave` to log save events
- Exposes a `/ping` route and an `/events` route
- Declares `content:read` and `content:write` capabilities
- Includes icon and screenshot assets for image audit testing

## Usage

Bundle and publish to a marketplace instance:

```bash
emdash plugin bundle --dir packages/plugins/marketplace-test
emdash plugin publish dist/marketplace-test-0.1.0.tar.gz --registry https://emdash-marketplace.cto.cloudflare.dev
```

## Testing

This plugin is designed to exercise every step of the marketplace pipeline:

1. **Bundle** — `emdash plugin bundle` builds `backend.js` from `sandbox-entry.ts`
2. **Upload** — tarball includes manifest, backend, icon, screenshot, README
3. **Code audit** — Workers AI analyzes `backend.js` (should pass — clean code)
4. **Image audit** — Workers AI analyzes `icon.png` and `screenshots/` (should pass)
5. **Status resolution** — enforcement mode determines final status
