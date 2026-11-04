---
"emdash": minor
---

Adds `dangerouslyEnableTestHooks` to the `emdash()` integration so end-to-end suites can run against a production build. It turns on the development-only endpoints (`/_emdash/api/setup/dev-bypass`, `/_emdash/api/auth/dev-bypass`, `/_emdash/api/setup/dev-reset`, `/_emdash/api/dev/emails`), the console email provider, and plain-HTTP localhost registry URLs, which otherwise work only under `astro dev`.

```js
emdash({
	database: sqlite({ url: "file:./test.db" }),
	dangerouslyEnableTestHooks: true,
});
```

The option is read at build time and defaults to `false`. Anyone who can reach a site built with it can sign in as an administrator, so use it only for test builds and never deploy one. `astro build` prints a warning when it is on. Builds without it behave as before.
