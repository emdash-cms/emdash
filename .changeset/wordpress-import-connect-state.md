---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the WordPress import wizard accepting a "Connect with WordPress" approval that it did not start. The wizard now sends a one-time value through WordPress, and `GET /_emdash/api/import/wordpress-plugin/callback` sends the admin back to the wizard without connecting unless that value returns within ten minutes. The callback also requires the `import:execute` permission, like the other import routes. When WordPress does not approve the connection, or the approval expires, the wizard now shows a message and its starting screen so the admin can reconnect.
