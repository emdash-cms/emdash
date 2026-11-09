---
"emdash": patch
---

Fixes dark mode styling across `Comments` and `CommentForm` components under `.dark`:

- Updates `Comments` to use a dark border color (`#374151`, overridable via `--ec-comment-border-color-dark`) for separators and reaction buttons.
- Inverts `.ec-comment-form-submit` in dark mode (`#f3f4f6` background, `#111827` text, overridable via `--ec-form-submit-bg-dark` and `--ec-form-submit-color-dark`) for high contrast against dark backgrounds.
- Fixes `.ec-comment-user-info` retaining a light border color in dark mode by applying `border-color: var(--ec-form-user-border-dark, #4b5563)`.
