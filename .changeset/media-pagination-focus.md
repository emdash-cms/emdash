---
"@emdash-cms/admin": patch
---

Fixes the Media Library moving keyboard focus to its pagination controls when the library reloads after a search or filter change. Focus returns to those controls only after a page they requested finishes loading, and stays wherever you moved it during the load.
