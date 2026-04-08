---
name: lingui-macro-patterns
description: Use when writing code with Lingui macros (t``, <Trans>, <Plural>, msg), debugging empty translated strings, ICU format errors, missing I18nProvider, or deciding between useMemo+t vs msg patterns in this codebase.
---

# Lingui Macro Patterns

Lingui macros are compile-time transforms. The Babel plugin rewrites them into `i18n._()` calls. This means **where and how you call them matters**.

## The Scope Rule

`t` from `useLingui()` only works in the same lexical scope. The Babel plugin matches the destructured `t` identifier — passing it as a function argument breaks the transform.

```tsx
// WRONG — t is a parameter, Babel doesn't transform it. Renders empty strings.
function getLabels(t) {
	return [t`Save`, t`Cancel`];
}
function MyComponent() {
	const { t } = useLingui();
	const labels = getLabels(t); // ["", ""]
}

// RIGHT — t`` used directly in useLingui() scope
function MyComponent() {
	const { t } = useLingui();
	const labels = React.useMemo(() => [t`Save`, t`Cancel`], [t]);
}
```

For data arrays (field types, menu items, options lists), inline them in `useMemo` inside the component. **This is the preferred pattern in this codebase.**

## What NOT to Translate

- Technical identifiers: `"JSON"`, field type slugs, CSS classes
- Email placeholders: `colleague@example.com`
- Code values: status enums, API paths, query params

## Why Not `msg` (Lazy Translations)?

Lingui offers `msg` from `@lingui/core/macro` for module-level constants. It creates a descriptor object resolved later with `i18n._()`. While this keeps data at module level, it relies on Lingui's global singleton rather than React context — mixing two mental models.

**This codebase uses `useMemo` + `t` instead.** Everything flows through `useLingui()`, staying within React's model. The tradeoff is data moves from module level into the component, but the code stays consistent — one pattern everywhere.

```tsx
// AVOID in this codebase — msg + i18n._() bypasses React context
import { msg } from "@lingui/core/macro";
const STATUS = { open: msg`Open`, closed: msg`Closed` };
function StatusBadge({ status }) {
	const { i18n } = useLingui();
	return <span>{i18n._(STATUS[status])}</span>; // global singleton, not React
}

// PREFERRED — useMemo + t, pure React
function StatusBadge({ status }) {
	const { t } = useLingui();
	const labels = React.useMemo(() => ({ open: t`Open`, closed: t`Closed` }), [t]);
	return <span>{labels[status]}</span>;
}
```

## ICU Escaping

Lingui uses ICU message format. Braces `{}` are special (variable placeholders). Single quotes `'` are the escape character.

| Want to render      | Write in `t`             | Why                                 |
| ------------------- | ------------------------ | ----------------------------------- |
| `{slug}` (literal)  | `t\`Pattern: '{slug}'\`` | Single quotes escape braces in ICU  |
| `it's`              | `t\`it''s\``             | Double single-quote for literal `'` |
| `{name}` (variable) | `t\`Hello ${name}\``     | JS interpolation, not ICU           |

## Import Paths

| Import            | Source                | Use for                              |
| ----------------- | --------------------- | ------------------------------------ |
| `useLingui`       | `@lingui/react/macro` | `t` in React components              |
| `Trans`, `Plural` | `@lingui/react/macro` | JSX with markup, plurals             |
| `msg`             | `@lingui/core/macro`  | Lazy translations outside components |
| `i18n`            | `@lingui/core`        | Resolving `msg` descriptors          |

**Never** import from `@lingui/react` or `@lingui/core` (without `/macro`) for macros — those are the runtime modules, not the compile-time transforms.

## Quick Reference

- **JSX with markup** → `<Trans>Read the <a>docs</a></Trans>`
- **Plurals** → `<Plural value={count} one="# item" other="# items" />`
- **Module-level constant** → avoid in this codebase (see above)

## Testing

Wrap renders in `I18nProvider`. Compose wrappers — never let per-test wrappers override it. See `tests/utils/render.tsx` for the shared helper.

## Common Mistakes

| Mistake                                  | Symptom                                        | Fix                               |
| ---------------------------------------- | ---------------------------------------------- | --------------------------------- |
| Pass `t` as function argument            | Empty strings at runtime                       | Inline in `useMemo` or use `msg`  |
| `{slug}` in `t` string                   | Text disappears or shows wrong                 | Escape as `'{slug}'`              |
| Import from `@lingui/react` not `/macro` | `t` is not a function                          | Use `@lingui/react/macro`         |
| Unicode ellipsis `…` vs `...`            | Drift from upstream text                       | Match existing source exactly     |
| No `I18nProvider` in tests               | "useLingui hook was used without I18nProvider" | Use shared render wrapper         |
| Test wrapper overrides I18nProvider      | Same error in tests with custom wrappers       | Compose wrappers, I18n on outside |

## After Modifying Components

Always run after adding or changing `t`/`<Trans>` strings:

```bash
pnpm --filter @emdash-cms/admin locale:extract
```
