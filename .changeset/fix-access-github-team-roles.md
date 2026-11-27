---
"@emdash-cms/cloudflare": patch
---

Fixes Cloudflare Access `roleMapping` ignoring GitHub teams and assigning `defaultRole` to new users. Use organization-qualified team names as mapping keys, such as `"my-org/Web Admins": 50`; bare team names are not matched because users can create identically named teams in other organizations. Teams are matched in the order returned by Access, after any IdP groups. Existing users keep their assigned roles unless `syncRoles` is enabled.
