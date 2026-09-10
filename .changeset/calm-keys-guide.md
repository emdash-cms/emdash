---
"@emdash-cms/admin": patch
---

Improves passkey account creation with device-aware guidance before the browser prompt. EmDash explains what a passkey is and where it is saved, detects when a built-in authenticator is unavailable, and guides users through Windows Hello, another device, or a security key. Compatible browsers receive a preference for the selected path, while the browser continues to control the secure passkey prompt.
