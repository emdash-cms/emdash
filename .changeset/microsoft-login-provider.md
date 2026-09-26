---
"emdash": minor
"@emdash-cms/auth": minor
---

Adds a `microsoft()` login provider, so editors can sign in to the admin with a Microsoft Entra ID work or school account next to passkeys and the other providers.

```js
import { microsoft } from "emdash/auth/providers/microsoft";

emdash({ authProviders: [microsoft()] });
```

The provider reads `EMDASH_OAUTH_MICROSOFT_CLIENT_ID`, `EMDASH_OAUTH_MICROSOFT_CLIENT_SECRET`, and `EMDASH_OAUTH_MICROSOFT_TENANT_ID` (or the unprefixed names) and stays unconfigured until all three are set. The tenant is a directory (tenant) ID, or `common`, `organizations`, or `consumers`. With a directory ID, an account that signs in through that directory counts as verified when its address is in the domain of its sign-in name, or when the optional `xms_edov` claim confirms the address's domain, so it can link to an existing user, accept an invite, sign up through an allowed domain, and create the first admin account. Accounts that sign in through another directory or identity provider, such as guests, and sign-ins through `common`, `organizations`, or `consumers` do not count as verified. `microsoft({ emailVerified })` overrides this either way.
