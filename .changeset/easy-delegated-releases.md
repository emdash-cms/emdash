---
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-client": minor
---

Adds `emdash-plugin release setup` to create the permanent GitHub Actions workflow for delegated plugin releases. The generated workflow builds and attests the plugin, waits for first-run browser authorization, and uploads its exact bundle and provenance through GitHub OIDC before publishing.

`ReleaseServiceClient.uploadReleaseArtifact()` supports custom workflows that need to stage checksum-bound bundle, image, or provenance bytes. Existing URL-source `release submit` workflows remain supported.
