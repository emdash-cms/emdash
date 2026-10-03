---
"emdash": patch
---

Fixes headless registry installs (plain Node, no bundler) so declarative registry-plugin pins and direct `installRegistryPins` calls work outside an Astro/Vite build.

- Adds declarative registry-plugin pins: a project's `registry-plugins.json` lists plugins by publisher DID, slug, and exact version, and `installRegistryPins` installs each pin through the same signed-record, checksum, and consent pipeline the admin UI uses — headlessly, at exact versions (the aggregator's "latest" selection never applies).
- Guards every `import.meta.env` read reachable outside the Astro surface with a `typeof import.meta.env !== "undefined"` check, since the published dist is plain ESM and any bare read threw a TypeError under plain Node (artifact URL validation, the install handler's artifact fetch, aggregator URL validation, and the dev console email provider gate).
- Adds an optional `installOpts` consent payload to `installRegistryPins` (`RegistryPinInstallOpts`), threaded verbatim into the install handler: headless callers fetch the signed record CIDs and acknowledged capabilities/MCP tools/public routes themselves, and without it pins still fail `RECORD_CONSENT_REQUIRED` / `DECLARED_ACCESS_REQUIRED` as before.
