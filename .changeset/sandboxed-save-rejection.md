---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes sandboxed `content:beforeSave` hooks being unable to reject content creation or updates.

Return a version 1 sandbox hook result with a `SAVE_REJECTED` error to stop the save and show the reason to the editor:

```ts
return {
	__emdashSandboxHookResult: true,
	version: 1,
	error: {
		code: "SAVE_REJECTED",
		reason: "Add a title before saving.",
	},
};
```

The reason must contain 1–500 characters of plain text. Invalid error results and unexpected sandbox exceptions stop the save with a generic hook error instead of exposing internal details.
