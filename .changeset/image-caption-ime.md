---
"@emdash-cms/admin": patch
---

Fixes typing image captions with an input method editor (IME) in the content editor. Each keystroke used to commit the unconverted text, so typing きむら in Japanese produced ｋいｍうｒあ; the caption now keeps the composition until it is converted and confirmed.
