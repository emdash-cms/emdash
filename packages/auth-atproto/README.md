# @emdash-cms/auth-atproto

Atmosphere/AT Protocol login provider for [EmDash](https://emdashcms.com). Lets users sign in to your EmDash admin with their [Atmosphere account](https://atmosphereaccount.com) — the same identity behind [Bluesky](https://bsky.app) and the wider AT Protocol network.

No client secrets, no OAuth-app registration. Users authenticate at their own provider; EmDash never sees a password.

## Installation

```shell
pnpm add @emdash-cms/auth-atproto
```

## Quick Start

```js
// astro.config.mjs
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { atproto } from "@emdash-cms/auth-atproto";

export default defineConfig({
	server: {
		host: "127.0.0.1", // required for local dev — see below
	},
	integrations: [
		emdash({
			authProviders: [atproto()],
		}),
	],
});
```

This adds **Sign in with Atmosphere** to the login page and the setup wizard. With no allowlist, the first user becomes Admin and self-signup is closed for everyone after that.

## Configuration

```js
atproto({
	allowedDIDs: ["did:plc:abc123..."],
	allowedHandles: ["*.example.com", "alice.bsky.social"],
	defaultRole: 30, // Author
});
```

| Option           | Type       | Default           | Description                                                                 |
| ---------------- | ---------- | ----------------- | --------------------------------------------------------------------------- |
| `allowedDIDs`    | `string[]` | —                 | DID allowlist. DIDs are permanent and can't be spoofed.                     |
| `allowedHandles` | `string[]` | —                 | Handle allowlist. Supports leading-wildcard patterns (`*.example.com`).     |
| `defaultRole`    | `number`   | `10` (Subscriber) | Role assigned to allowed users after the first. First user is always Admin. |

If both lists are set, a user matching either is admitted. Handle matches are independently verified against the handle's DNS/HTTP record before being trusted.

## Local development

The AT Protocol OAuth profile requires loopback redirect URIs to use the IP literal `127.0.0.1` rather than `localhost`. Vite (the dev server Astro uses) binds to `localhost` by default, so set `server.host` to `127.0.0.1` and visit `http://127.0.0.1:4321/_emdash/admin` for the whole flow. Otherwise the cookie set on `localhost` won't be visible after the redirect lands you on `127.0.0.1`.

## Production

The provider serves its own OAuth client metadata at `/.well-known/atproto-client-metadata.json`. Authorization servers fetch this URL during login, so your deployment needs to be reachable on the public internet over HTTPS. Set [`siteUrl`](https://docs.emdashcms.com/reference/configuration#siteurl) if you're behind a TLS-terminating reverse proxy.

## Documentation

See the [Atmosphere login guide](https://docs.emdashcms.com/guides/atmosphere-auth/) for the full reference, including allowlist semantics, role assignment, and troubleshooting.
