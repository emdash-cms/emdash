---
"emdash": minor
---

Adds runtime resolution of S3 storage config from `S3_*` environment
variables (`S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`,
`S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_PUBLIC_URL`). Any field omitted from
`s3({...})` is read from the matching env var on Node at runtime, so
container images can be built once and receive credentials at boot without a
rebuild. Explicit values in `s3({...})` still take precedence.

`s3()` with no arguments is now valid for fully env-driven deployments.
`accessKeyId` and `secretAccessKey` are now optional in `S3StorageConfig`
(both or neither). Workers users should continue passing explicit values to
`s3({...})`.
