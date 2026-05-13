---
"@emdash-cms/admin": patch
"emdash": patch
---

Fixes the slash command menu's initial selection getting overridden when the menu opens under a stationary pointer. The menu items previously reacted to `mouseenter` unconditionally, so an item rendered beneath the cursor would steal selection from the keyboard default before any user interaction. Mouse-hover-selects still works, but only after the user actually moves the pointer over the menu.
