This is an EmDash site template built for the templates/ directory in the main repo.

## Commands

```bash
npx emdash dev
npx emdash types
npx emdash seed seed/seed.json --validate
```

The admin UI is at `http://localhost:4321/_emdash/admin`.

## Notes

- Keep all content routes server-rendered.
- Use `Astro.cache.set(cacheHint)` after EmDash content queries.
- `entry.id` is the slug used in URLs. `entry.data.id` is the ULID for APIs like `getEntryTerms()`.
- Image fields are rendered with `<Image image={...} />` from `emdash/ui`.
- This template is intentionally styled as a premium dark editorial starter.
