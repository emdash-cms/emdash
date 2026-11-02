---
"emdash": patch
---

Fixes dark mode styling across `Comments` and `CommentForm` components:
- Updates `Comments` to use dark border colors for separators and reaction buttons in dark mode and `prefers-color-scheme: dark`.
- Inverts `.ec-comment-form-submit` in dark mode to ensure high contrast against dark backgrounds.
- Fixes the border of `.ec-comment-user-info` retaining a light border color in dark mode.
- Adds `@media (prefers-color-scheme: dark)` fallbacks for environments without a root `.dark` class.
