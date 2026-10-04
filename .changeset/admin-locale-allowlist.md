---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds an `admin.locales` option that limits the admin interface to the languages a site uses, which makes the admin bundle smaller.

```js
emdash({
	admin: { locales: ["en", "de"] },
});
```

Only the listed languages are built into the admin and offered in its language switcher. Users whose preferred languages aren't listed see English. `en` is always included as the fallback, even when the list leaves it out, so `admin: { locales: ["en-GB"] }` still ships English alongside British English. A code the admin doesn't ship fails the build, and the error lists the available codes. Sites that don't set the option keep every language.
