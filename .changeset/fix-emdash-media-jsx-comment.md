---
"emdash": patch
---

Fixes a build failure in the `EmDashMedia` component. The component-embed branch contained HTML comments (`<!-- ... -->`) inside a JSX expression, which the Astro compiler rejects with "Unexpected token", breaking every production `astro build` and returning 500s in dev on any page that renders media. The note is now a JSX comment.
