---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Adds a `syncName` option to external auth providers such as Cloudflare Access. By default, EmDash still replaces a user's name with the provider's name on every authenticated request, so a name edited in the admin is restored on that user's next request. Set `syncName: false` to keep names edited in the admin; the provider's name is then used only when the user is first provisioned.

```js
auth: access({
	teamDomain: "myteam.cloudflareaccess.com",
	syncName: false,
}),
```
