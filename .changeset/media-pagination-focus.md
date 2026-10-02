---
"@emdash-cms/admin": patch
---

Fixes keyboard focus in the Media Library pagination controls. Focus no longer jumps to those controls when the library reloads after a search or filter change; it returns to them only after a page they requested finishes loading, and stays wherever you moved it during the load. Picking a page or a page size from a dropdown returns focus to that dropdown, and when the page reached disables the button you pressed, such as Previous on the first page, focus moves to the page picker instead of being lost.
