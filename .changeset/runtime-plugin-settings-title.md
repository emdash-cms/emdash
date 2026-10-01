---
"emdash": patch
---

Fixes the settings page of a plugin installed from the registry or marketplace showing the plugin's internal ID, such as `r_dsniqezhchh4zone`, as its title instead of its name. The admin endpoint `GET /_emdash/api/admin/plugins/:id` returns these plugins with the same details as the plugin list instead of a 404.
