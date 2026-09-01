---
"emdash": minor
"@emdash-cms/plugin-cli": patch
---

Adds an `observe` option to the `content:beforeSave` hook config so plugins can watch saves without requesting write access. An observe hook registers with the `content:read` capability instead of `content:write`; it receives a copy of the content, its return value is discarded, and errors it throws are logged without blocking the save, so it cannot affect what is saved.

```ts
hooks: {
	"content:beforeSave": {
		observe: true,
		handler: async (event, ctx) => {
			// read event.content, capture state, log — but never mutate
		},
	},
},
```

Hooks that return modified content are unchanged and still require `content:write`. The warning logged when a `content:beforeSave` hook is skipped for a missing capability now mentions the `observe` option.

The `content:beforeSave` event also gains an `id` field, set when updating existing content. The update payload's `content` carries only the submitted field data, so this is the only way for a hook to know which item is being saved; it is absent on creates, where the id is generated after the hook runs.
