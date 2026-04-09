# @emdash-cms/plugin-worker-mailer

SMTP provider plugin for EmDash on Cloudflare Workers using `@workermailer/smtp`.

The plugin supports secure SMTP in both modes exposed by Cloudflare TCP sockets:

- `starttls` on port `587`
- `implicit_tls` on port `465`

Plaintext SMTP is intentionally not exposed.

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
	port: 587,
	transportSecurity: "starttls",
	authType: "plain",
	username: "smtp-user",
	password: "smtp-password",
	fromEmail: "no-reply@example.com",
	fromName: "EmDash Demo",
});
```

## Settings

- `host`: SMTP hostname
- `transportSecurity`: `starttls` or `implicit_tls`
- `port`: SMTP port, usually `587` for STARTTLS or `465` for implicit TLS
- `authType`: `plain`, `login`, or `cram-md5`
- `username`: SMTP username
- `password`: SMTP password
- `fromEmail`: sender email override, defaults to `username`
- `fromName`: optional sender display name
