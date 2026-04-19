/**
 * plugin-email-on-publish
 *
 * Sends an email whenever content is published.
 * Supports three providers, configured via CF environment variables:
 *   EMAIL_PROVIDER = "mailchannels" | "resend" | "sendgrid"
 *
 * Required env vars (set in CF Dashboard → Workers & Pages → Settings → Variables & Secrets):
 *
 *   All providers:
 *     EMAIL_PROVIDER      — which provider to use (mailchannels | resend | sendgrid)
 *     EMAIL_FROM          — sender address (e.g. cms@yourdomain.com)
 *     EMAIL_TO            — recipient address (e.g. you@yourdomain.com)
 *
 *   Resend only:
 *     RESEND_API_KEY      — from resend.com dashboard
 *
 *   SendGrid only:
 *     SENDGRID_API_KEY    — from sendgrid.com dashboard
 *
 *   MailChannels:
 *     No API key needed — works natively on Cloudflare Workers (free)
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

// ---------------------------------------------------------------------------
// Provider implementations
// ---------------------------------------------------------------------------

async function sendViaMailChannels(
  from: string,
  to: string,
  subject: string,
  html: string
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
    const text = await response.text();
    throw new Error(`MailChannels error ${response.status}: ${text}`);
  }
}

async function sendViaResend(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string
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
    const text = await response.text();
    throw new Error(`Resend error ${response.status}: ${text}`);
  }
}

async function sendViaSendGrid(
  apiKey: string,
  from: string,
  to: string,
  subject: string,
  html: string
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

  // SendGrid returns 202 on success (not 200)
  if (response.status !== 202) {
    const text = await response.text();
    throw new Error(`SendGrid error ${response.status}: ${text}`);
  }
}

// ---------------------------------------------------------------------------
// Email body builder
// ---------------------------------------------------------------------------

function buildEmailHtml(title: string, collection: string, id: string): string {
  return `
    <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1a1a1a;">📢 New content published</h2>
      <table style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 8px; color: #555; width: 120px;">Title</td>
          <td style="padding: 8px; font-weight: bold;">${title}</td>
        </tr>
        <tr style="background: #f9f9f9;">
          <td style="padding: 8px; color: #555;">Collection</td>
          <td style="padding: 8px;">${collection}</td>
        </tr>
        <tr>
          <td style="padding: 8px; color: #555;">ID</td>
          <td style="padding: 8px; font-family: monospace; font-size: 12px;">${id}</td>
        </tr>
      </table>
      <p style="color: #888; font-size: 12px; margin-top: 24px;">
        Sent by EmDash plugin-email-on-publish
      </p>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

export default () =>
  definePlugin({
    id: "email-on-publish",
    version: "1.0.0",
    capabilities: ["read:content", "network:fetch"],

    hooks: {
      "content:afterSave": {
        handler: async (event: any, ctx: PluginContext) => {
          // Only fire on publish
          if (event.content.status !== "published") return;

          const env = (ctx as any).env ?? {};

          const provider = env.EMAIL_PROVIDER ?? "mailchannels";
          const from = env.EMAIL_FROM;
          const to = env.EMAIL_TO;

          // Validate required vars
          if (!from || !to) {
            ctx.log.error(
              "[email-on-publish] Missing EMAIL_FROM or EMAIL_TO env vars"
            );
            return;
          }

          const title = event.content.title ?? "Untitled";
          const collection = event.collection ?? "unknown";
          const id = event.content.id ?? "";
          const subject = `Published: ${title}`;
          const html = buildEmailHtml(title, collection, id);

          try {
            switch (provider) {
              case "mailchannels":
                await sendViaMailChannels(from, to, subject, html);
                break;

              case "resend": {
                const apiKey = env.RESEND_API_KEY;
                if (!apiKey) {
                  ctx.log.error(
                    "[email-on-publish] Missing RESEND_API_KEY env var"
                  );
                  return;
                }
                await sendViaResend(apiKey, from, to, subject, html);
                break;
              }

              case "sendgrid": {
                const apiKey = env.SENDGRID_API_KEY;
                if (!apiKey) {
                  ctx.log.error(
                    "[email-on-publish] Missing SENDGRID_API_KEY env var"
                  );
                  return;
                }
                await sendViaSendGrid(apiKey, from, to, subject, html);
                break;
              }

              default:
                ctx.log.error(
                  `[email-on-publish] Unknown EMAIL_PROVIDER: "${provider}". Use mailchannels | resend | sendgrid`
                );
                return;
            }

            ctx.log.info(
              `[email-on-publish] Email sent via ${provider} for "${title}"`
            );
          } catch (err: any) {
            ctx.log.error(`[email-on-publish] Failed to send email: ${err.message}`);
          }
        },
      },
    },
  });
