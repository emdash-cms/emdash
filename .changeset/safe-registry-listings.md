---
"@emdash-cms/registry-client": minor
"@emdash-cms/admin": minor
"emdash": minor
---

Adds signed-label policy and listing-status support to the plugin registry client. Registry requests use the aggregator's required listing policy with an optional accepted-labeler declaration, and withdrawn releases are excluded from install and update results.

The EmDash admin waits for a fresh listing-policy response before rendering registry metadata, uses the approved author name or publisher DID instead of a mutable handle, and does not request media for an unapproved release. Install, update, and media-proxy checks enforce listing withdrawal independently from the existing plugin-code and capability checks.

Registry artifact downloads and proxied media connect only to the public IP addresses validated for each URL, preventing DNS changes between validation and connection from reaching private services.
