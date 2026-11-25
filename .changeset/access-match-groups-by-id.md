---
"@emdash-cms/cloudflare": minor
---

Adds a `matchGroupsBy` option to the Cloudflare Access adapter so `roleMapping` can be keyed by IdP group ID instead of group display name. Some identity providers allow several groups with the same name and let members create groups, so with name matching a group named like a mapped key receives that key's role.

Name matching stays the default. If members of your directory can create or rename groups, set `matchGroupsBy: "id"` and replace each group-name key with the group's `id` as reported by Access:

```ts
auth: access({
	teamDomain: "myteam.cloudflareaccess.com",
	matchGroupsBy: "id",
	roleMapping: {
		"0b5c8e2a-3f1d-4c7e-9a61-2d4f8b7c1e90": 50,
	},
}),
```

The `[cf-access] Identity from Access` log line now includes each group's `id` as well as its name. Matching by ID only helps when those differ: some generic SAML and OIDC providers report the group name as its `id`, and in that case you should restrict who can create groups in your identity provider instead. GitHub team keys keep the `"organization-name/team-name"` form with either setting.
