---
"@emdash-cms/admin": minor
---

Adds public names for registry plugins in the `@publisher.example/plugin-slug` format. Registry results and installed-plugin cards display the verified public name and link to a handle-based detail URL, while exact public-name searches open the matching package.

When a publisher handle conclusively fails identity verification, the admin displays **INVALID HANDLE** and prevents installation. Temporary lookup failures fall back to the stable publisher identifier without marking the handle invalid.
