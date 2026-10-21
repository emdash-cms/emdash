---
"@emdash-cms/admin": patch
---

Fixes failure toasts in the admin rendering in the neutral style instead of the error style. Success and warning toasts that set a style now show it too. Toasts returned by plugin editor panels and actions use the success, error, or info style named by their `type`.
