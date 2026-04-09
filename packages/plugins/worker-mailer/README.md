# @emdash-cms/plugin-worker-mailer

SMTP provider plugin for EmDash on Cloudflare Workers using `@workermailer/smtp`.

Cloudflare Workers SMTP connections must start secure, so this plugin uses
implicit TLS / SMTPS and does not expose plaintext or STARTTLS upgrade flows.

## Usage

Register the plugin in `astro.config.mjs`:

```js
import { workerMailerPlugin } from "@emdash-cms/plugin-worker-mailer";

export default defineConfig({
	integrations: [
		emdash({
			sandboxed: [workerMailerPlugin()],
		}),
	],
});
```

Configure the SMTP connection in the EmDash admin UI at the plugin's settings page.
On install, the plugin seeds secure defaults for:

- `port = 465`
- `authType = "plain"`

## Settings

- `host`: SMTP hostname
- `port`: SMTP port, usually `465` for implicit TLS / SMTPS
- `authType`: `plain`, `login`, or `cram-md5`
- `username`: SMTP username
- `password`: SMTP password
- `fromEmail`: sender email override, defaults to `username`
- `fromName`: optional sender display name
