---
"@emdash-cms/registry-loader": patch
---

Adds an `includeLatestRelease` option to the collection filter, for example `getLiveCollection("plugins", { limit: 20, includeLatestRelease: true })`. Each entry then also carries its package's latest release as `latestRelease`, the same data `getLiveEntry` returns, so a listing can show release artifacts such as icons. It costs one extra registry request per package that has a published release. An entry whose release can't be loaded within 3 seconds is returned without it, and failures other than a missing release are logged as warnings.
