---
"emdash": patch
---

Fixes a plugin storage range filter whose every bound is `undefined` matching every row instead of failing. Building a bound from an optional value — `where: { stock: { gte: minStock } }` where `minStock` is `undefined` — type-checks, but contributed no SQL, so `query()` and `count()` returned the whole collection and `updateIf()` applied its write with no guard at all. A guarded decrement could then drive a counter past the bound the caller asked for.

Such a filter now throws `StorageQueryError` naming the field. Pass a defined bound, or omit the field when you mean to match unconditionally:

```typescript
const where = minStock === undefined ? {} : { stock: { gte: minStock } };
await ctx.storage.products.query({ where });
```
