---
"emdash": minor
---

Adds a generator meta tag to every page that renders `<EmDashHead>`, so the page's HTML names the CMS that made it. The tag shows EmDash's major version only:

```html
<meta name="generator" content="EmDash 1" />
```

After upgrading, sites using `<EmDashHead>` include the tag with no configuration. To leave it out, set `generator: false`:

```js title="astro.config.mjs"
emdash({
	generator: false,
});
```
