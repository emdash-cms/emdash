# @emdash-cms/plugin-worker-mailer

SMTP provider plugin for EmDash on Cloudflare Workers using
`@ribassu/worker-mailer`.

Cloudflare Workers only supports SMTP connections that start already secure
(implicit TLS / SMTPS). STARTTLS is not supported by this plugin.

## Usage

Register the plugin in `astro.config.mjs`:

```js
import { workerMailerPlugin } from "@emdash-cms/plugin-worker-mailer";

export default defineConfig({
	integrations: [
		emdash({
			plugins: [workerMailerPlugin()],
		}),
	],
});
```

Configure the SMTP connection in the EmDash admin UI, or seed defaults in code:

```js
workerMailerPlugin({
	host: "smtp.example.com",
	port: 465,
	authType: "plain",
	username: "smtp-user",
	password: "smtp-password",
	fromEmail: "no-reply@example.com",
	fromName: "EmDash Demo",
});
```

## Settings

- `host`: SMTP hostname for an implicit TLS endpoint
- `port`: SMTP port for implicit TLS, usually `465`
- `authType`: `plain`, `login`, or `cram-md5`
- `username`: SMTP username
- `password`: SMTP password
- `fromEmail`: sender email override, defaults to `username`
- `fromName`: optional sender display name
