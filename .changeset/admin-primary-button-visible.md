---
"@emdash-cms/admin": patch
---

Fixes invisible primary buttons in the admin (notably "Sign in with Passkey" on the login page and "Register Passkey"), which could render as white text on a white background and leave passkey login unreachable by keyboard or sight. The admin's prebuilt stylesheet now matches the design-system version it ships against, so emphasis buttons paint their gradient background correctly.
