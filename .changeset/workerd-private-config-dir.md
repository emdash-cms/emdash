---
"@emdash-cms/sandbox-workerd": patch
---

Fixes the Node.js sandbox runner creating its temporary `emdash-workerd-*` directory and generated plugin wrapper files with the default permissions, which let other accounts on the same host read them. The directory is now accessible only to the user running the site. No configuration changes are required.
