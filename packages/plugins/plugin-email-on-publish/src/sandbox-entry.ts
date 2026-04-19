// src/sandbox-entry.ts — plugin definition, runs at request time
// This is the actual plugin logic. Works in both trusted and sandboxed modes.
// Uses only Web APIs (fetch) — no Node.js built-ins.
//
// Configure via CF Dashboard → Workers & Pages → Settings → Variables & Secrets:
//
//   EMAIL_PROVIDER   mailchannels | resend | sendgrid  (default: mailchannels)
//   EMAIL_FROM       sender address e.g. cms@yourdomain.com
//   EMAIL_TO         recipient address e.g. you@yourdomain.com
//   RESEND_API_KEY   required only when EMAIL_PROVIDER=resend
//   SENDGRID_API_KEY required only when EMAIL_PROVIDER=sendgrid

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

// ---------------------------------------------------------------------------
// Provider implementations (Web API fetch only — sandbox compatible)
// ---------------------------------------------------------------------------

async function sendViaMailChannels(
	from: string,
	to: string,
	subject: string,
	html: string,
): Promise<void> {
	const response = await fetch("https://api.mailchannels.net/tx/v1/send", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			personalizations: [{ to: [{ email: to }] }],
			from: { email: from },
			subject,
			content: [{ type: "text/html", value: html }],
		}),
	});
	if (!response.ok) {
		throw new Error(`MailChannels ${response.status}: ${await response.text()}`);
	}
}

async function sendViaResend(
	apiKey: string,
	from: string,
	to: string,
	subject: string,
	html: string,
): Promise<void> {
	const response = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ from, to, subject, html }),
	});
	if (!response.ok) {
		throw new Error(`Resend ${response.status}: ${await response.text()}`);
	}
}

async function sendViaSendGrid(
	apiKey: string,
	from: string,
	to: string,
	subject: string,
	html: string,
): Promise<void> {
	const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			personalizations: [{ to: [{ email: to }] }],
			from: { email: from },
			subject,
			content: [{ type: "text/html", value: html }],
		}),
	});
	// SendGrid returns 202 Accepted on success
	if (response.status !== 202) {
		throw new Error(`SendGrid ${response.status}: ${await response.text()}`);
	}
}

// ---------------------------------------------------------------------------
// Email HTML builder
// ---------------------------------------------------------------------------

function buildHtml(title: string, collection: string, id: string): string {
	return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto;">
      <h2 style="color:#1a1a1a;">📢 New content published</h2>
      <table style="width:100%;border-collapse:collapse;">
        <tr>
          <td style="padding:8px;color:#555;width:120px;">Title</td>
          <td style="padding:8px;font-weight:bold;">${title}</td>
        </tr>
        <tr style="background:#f9f9f9;">
          <td style="padding:8px;color:#555;">Collection</td>
          <td style="padding:8px;">${collection}</td>
        </tr>
        <tr>
          <td style="padding:8px;color:#555;">ID</td>
          <td style="padding:8px;font-family:monospace;font-size:12px;">${id}</td>
        </tr>
      </table>
      <p style="color:#888;font-size:12px;margin-top:24px;">
        Sent by EmDash · plugin-email-on-publish
      </p>
    </div>`;
}

// ---------------------------------------------------------------------------
// Plugin definition (default export required)
// ---------------------------------------------------------------------------

export default definePlugin({
	hooks: {
		"content:afterSave": {
			handler: async (event: any, ctx: PluginContext) => {
				// Only fire when content transitions to published
				if (event.content.status !== "published") return;

				const env = (ctx as any).env ?? {};
				const provider: string = env.EMAIL_PROVIDER ?? "mailchannels";
				const from: string = env.EMAIL_FROM ?? "";
				const to: string = env.EMAIL_TO ?? "";

				if (!from || !to) {
					ctx.log.error("[email-on-publish] EMAIL_FROM and EMAIL_TO must be set");
					return;
				}

				const title = event.content.title ?? "Untitled";
				const collection = event.collection ?? "unknown";
				const id = event.content.id ?? "";
				const subject = `Published: ${title}`;
				const html = buildHtml(title, collection, id);

				try {
					switch (provider) {
						case "mailchannels":
							await sendViaMailChannels(from, to, subject, html);
							break;

						case "resend": {
							const key = env.RESEND_API_KEY;
							if (!key) {
								ctx.log.error("[email-on-publish] RESEND_API_KEY not set");
								return;
							}
							await sendViaResend(key, from, to, subject, html);
							break;
						}

						case "sendgrid": {
							const key = env.SENDGRID_API_KEY;
							if (!key) {
								ctx.log.error("[email-on-publish] SENDGRID_API_KEY not set");
								return;
							}
							await sendViaSendGrid(key, from, to, subject, html);
							break;
						}

						default:
							ctx.log.error(
								`[email-on-publish] Unknown provider "${provider}". Use: mailchannels | resend | sendgrid`,
							);
							return;
					}

					ctx.log.info(`[email-on-publish] ✓ Sent via ${provider} — "${title}"`);
				} catch (err: any) {
					ctx.log.error(`[email-on-publish] Send failed: ${err.message}`);
				}
			},
		},
	},
});
