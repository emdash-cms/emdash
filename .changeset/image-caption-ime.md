---
"@emdash-cms/admin": patch
---

Fixes typing image and video captions with an input method editor (IME) in the content editor. Each keystroke used to commit the unconverted text, so typing きむら in Japanese produced ｋいｍうｒあ; captions now keep the composition until it is converted and confirmed.
