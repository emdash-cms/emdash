---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the login, signup, and invite-accept pages showing the stock EmDash mark and name even when a custom `admin.logo`/`admin.siteName` is configured for white-labeling. These pre-authentication pages now render the configured logo and site name (completing the scope approved in #639/PR #705, which wired branding into the sidebar and setup wizard but missed the pages users see before signing in), falling back to the default EmDash mark when no custom branding is configured.
