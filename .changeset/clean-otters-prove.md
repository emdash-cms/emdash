---
"@emdash-cms/registry-client": minor
---

Adds `DirectPdsClient.getPackageRepository()` for reading a package profile and every package release from one proof-verified AT Protocol repository export.

Use the method when authorization or version selection requires a complete signed package snapshot:

```ts
const { profile, releases } = await directPdsClient.getPackageRepository("gallery");
```

The client verifies the repository commit signature, record blocks, and complete Merkle search tree before returning records. Unsigned `repo.getRecord` and `repo.listRecords` envelopes cannot substitute or omit package data. Repository exports use the client's `maxResponseBytes` limit, which defaults to 5 MiB, and a missing export reports `REPOSITORY_NOT_FOUND`.
