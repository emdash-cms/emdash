---
"@emdash-cms/registry-verification": patch
---

Fixes the generated `createRequire` shim in the ESM build so the synthetic file URL includes a drive letter. The previous driveless URL (`file:///emdash-registry-verification.js`) was rejected by `fileURLToPath()` on Windows, causing builds that inline this package (such as `emdash@0.37.0` on Windows) to fail when the Astro config was loaded.
