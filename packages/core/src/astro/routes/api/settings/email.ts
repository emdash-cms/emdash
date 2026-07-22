/**
 * Email Settings API endpoint
 *
 * GET  /_emdash/api/settings/email      — current provider, available providers, middleware
 * POST /_emdash/api/settings/email/test — send a test email through the full pipeline
 */

import { escapeHtml } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { OptionsRepository } from "#db/repositories/options.js";
import {
	CLOUDFLARE_EMAIL_PLUGIN_ID,
	loadCloudflareConfigFromDb,
	loadCloudflareConfigFromEnv,
	saveCloudflareConfigToDb,
} from "#plugins/email-cloudflare.js";
import {
	loadSmtpConfigFromDb,
	loadSmtpConfigFromEnv,
	saveSmtpConfigToDb,
	SMTP_EMAIL_PLUGIN_ID,
} from "#plugins/email-smtp.js";
import { EXCLUSIVE_HOOK_NONE_VALUE } from "#plugins/hooks.js";

export const prerender = false;

const EMAIL_DELIVER_HOOK = "email:deliver";
const EMAIL_BEFORE_SEND_HOOK = "email:beforeSend";
const EMAIL_AFTER_SEND_HOOK = "email:afterSend";

/**
 * GET /_emdash/api/settings/email
 *
 * Returns the email configuration state:
 * - Current provider selection
 * - Available providers (plugins with email:deliver)
 * - Active middleware (email:beforeSend / email:afterSend plugins)
 * - Whether email is available
 */
export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const pipeline = emdash.hooks;
		const optionsRepo = new OptionsRepository(emdash.db);

		// Get email:deliver providers and current selection
		const providers = pipeline.getExclusiveHookProviders(EMAIL_DELIVER_HOOK);
		const selectedProviderId = await optionsRepo.get<string>(
			`emdash:exclusive_hook:${EMAIL_DELIVER_HOOK}`,
		);

		// Get middleware hooks (beforeSend / afterSend). These are non-exclusive —
		// many plugins can subscribe — so we enumerate non-exclusive providers.
		const beforeSendPlugins = pipeline
			.getHookProviders(EMAIL_BEFORE_SEND_HOOK)
			.map((p) => p.pluginId);
		const afterSendPlugins = pipeline
			.getHookProviders(EMAIL_AFTER_SEND_HOOK)
			.map((p) => p.pluginId);

		// Cloudflare Email config — DB takes precedence over env vars
		let cloudflareStatus: {
			configured: boolean;
			source: "db" | "env" | null;
			fromName?: string;
			fromEmail?: string;
			replyTo?: string;
		} = { configured: false, source: null };
		const dbCfConfig = await loadCloudflareConfigFromDb(emdash.db);
		if (dbCfConfig) {
			cloudflareStatus = {
				configured: true,
				source: "db",
				fromName: dbCfConfig.fromName,
				fromEmail: dbCfConfig.fromEmail,
				...(dbCfConfig.replyTo ? { replyTo: dbCfConfig.replyTo } : {}),
			};
		} else {
			const envCfConfig = loadCloudflareConfigFromEnv();
			if (envCfConfig) {
				cloudflareStatus = {
					configured: true,
					source: "env",
					fromName: envCfConfig.fromName,
					fromEmail: envCfConfig.fromEmail,
					...(envCfConfig.replyTo ? { replyTo: envCfConfig.replyTo } : {}),
				};
			}
		}

		// SMTP transport status — DB config takes precedence over env vars
		let smtpStatus: {
			configured: boolean;
			source: "db" | "env" | null;
			host?: string;
			port?: number;
			secure?: "starttls" | "tls";
			fromName?: string;
			fromEmail?: string;
			replyTo?: string;
		} = { configured: false, source: null };
		try {
			const encryptionKey =
				import.meta.env.EMDASH_ENCRYPTION_KEY ?? process.env.EMDASH_ENCRYPTION_KEY;
			const dbConfig = encryptionKey ? await loadSmtpConfigFromDb(emdash.db, encryptionKey) : null;
			const envConfig = loadSmtpConfigFromEnv();

			if (dbConfig) {
				smtpStatus = {
					configured: true,
					source: "db",
					host: dbConfig.host,
					port: dbConfig.port,
					secure: dbConfig.secure,
					user: dbConfig.user,
					...(dbConfig.fromName ? { fromName: dbConfig.fromName } : {}),
					...(dbConfig.fromEmail ? { fromEmail: dbConfig.fromEmail } : {}),
					...(dbConfig.replyTo ? { replyTo: dbConfig.replyTo } : {}),
				};
			} else if (envConfig) {
				smtpStatus = {
					configured: true,
					source: "env",
					host: envConfig.host,
					port: envConfig.port,
					secure: envConfig.secure,
					user: envConfig.user,
					...(envConfig.fromName ? { fromName: envConfig.fromName } : {}),
					...(envConfig.fromEmail ? { fromEmail: envConfig.fromEmail } : {}),
					...(envConfig.replyTo ? { replyTo: envConfig.replyTo } : {}),
				};
			}
		} catch {
			// Invalid SMTP config — show as unconfigured rather than breaking the page
		}

		const explicitlyDisabled = selectedProviderId === EXCLUSIVE_HOOK_NONE_VALUE;

		return apiSuccess({
			available: explicitlyDisabled ? false : (emdash.email?.isAvailable() ?? false),
			providers: providers.map((p) => ({
				pluginId: p.pluginId,
			})),
			selectedProviderId: explicitlyDisabled ? null : (selectedProviderId ?? null),
			middleware: {
				beforeSend: beforeSendPlugins,
				afterSend: afterSendPlugins,
			},
			smtp: smtpStatus,
			cloudflare: cloudflareStatus,
		});
	} catch (error) {
		return handleError(error, "Failed to get email settings", "EMAIL_SETTINGS_READ_ERROR");
	}
};

/**
 * POST /_emdash/api/settings/email/test
 *
 * Send a test email through the full pipeline.
 * Validates the pipeline is configured and the provider works.
 */
const testEmailBody = z.object({
	to: z.string().email(),
});

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	if (!emdash.email?.isAvailable()) {
		return apiError(
			"EMAIL_NOT_CONFIGURED",
			"No email provider is configured. Install and activate an email provider plugin.",
			503,
		);
	}

	try {
		const body = await parseBody(request, testEmailBody);
		if (isParseError(body)) return body;

		const optionsRepo = new OptionsRepository(emdash.db);
		const siteName = (await optionsRepo.get<string>("emdash:site_title")) ?? "EmDash";
		const safeName = escapeHtml(siteName);

		await emdash.email.send(
			{
				to: body.to,
				subject: `Test email from ${siteName}`,
				text: `This is a test email from ${siteName}.\n\nIf you received this, your email provider is working correctly.`,
				html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.5; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
  <h1 style="font-size: 24px; margin-bottom: 20px;">Test Email</h1>
  <p>This is a test email from <strong>${safeName}</strong>.</p>
  <p>If you received this, your email provider is working correctly.</p>
  <p style="color: #666; font-size: 14px; margin-top: 30px;">
    Sent via the EmDash email pipeline.
  </p>
</body>
</html>`,
			},
			"admin",
		);

		return apiSuccess({
			success: true,
			message: `Test email sent to ${body.to}`,
		});
	} catch (error) {
		// Surface the underlying delivery error so the admin can act on it —
		// e.g. "535 authentication failed" vs "connection refused" need very
		// different fixes. Never expose raw stack traces; only the message.
		const detail = error instanceof Error ? error.message : String(error);
		console.error("[EMAIL_TEST_ERROR]", error);
		return apiError("EMAIL_TEST_ERROR", `Failed to send test email: ${detail}`, 502);
	}
};

// ---------------------------------------------------------------------------
// PUT /_emdash/api/settings/email — configure email provider
// ---------------------------------------------------------------------------

const smtpConfigSchema = z.object({
	host: z.string().min(1),
	port: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.refine((p) => p !== 25, {
			message:
				"Port 25 is not supported: Cloudflare blocks outbound port 25. Use 587 (STARTTLS) or 465 (implicit TLS) instead.",
		}),
	secure: z.enum(["starttls", "tls"]),
	user: z.string().min(1),
	pass: z.string().min(1).optional(), // undefined = keep existing password
	fromName: z.string().optional(),
	fromEmail: z.string().email().optional(),
	replyTo: z.string().email().optional(),
});

const cloudflareConfigSchema = z.object({
	fromName: z.string().min(1),
	fromEmail: z.string().email(),
	replyTo: z.string().email().optional(),
});

const emailSettingsBody = z.discriminatedUnion("provider", [
	z.object({ provider: z.literal("none") }),
	z.object({ provider: z.literal("smtp"), smtp: smtpConfigSchema }),
	z.object({ provider: z.literal("cloudflare"), cloudflare: cloudflareConfigSchema }),
]);

export const PUT: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "settings:manage");
	if (denied) return denied;

	try {
		const body = await parseBody(request, emailSettingsBody);
		if (isParseError(body)) return body;

		const encryptionKey =
			import.meta.env.EMDASH_ENCRYPTION_KEY ?? process.env.EMDASH_ENCRYPTION_KEY;
		const optionsRepo = new OptionsRepository(emdash.db);
		const optionKey = `emdash:exclusive_hook:${EMAIL_DELIVER_HOOK}`;

		switch (body.provider) {
			case "none": {
				// Explicitly disable: store the none-sentinel (not a delete) so
				// exclusive-hook resolution does not auto-select a provider again
				// on the next startup. SMTP/Cloudflare config is kept for re-use.
				await optionsRepo.set(optionKey, EXCLUSIVE_HOOK_NONE_VALUE);
				emdash.hooks.clearExclusiveSelection(EMAIL_DELIVER_HOOK);
				return apiSuccess({ success: true, message: "Email provider disabled" });
			}

			case "smtp": {
				if (!encryptionKey) {
					return apiError(
						"ENCRYPTION_KEY_MISSING",
						"EMDASH_ENCRYPTION_KEY is required to store SMTP credentials securely",
						500,
					);
				}

				// If no new password provided, keep the existing one from DB
				let pass = body.smtp.pass;
				if (!pass) {
					const existing = await loadSmtpConfigFromDb(emdash.db, encryptionKey);
					if (!existing) {
						return apiError(
							"VALIDATION_ERROR",
							"Password is required for initial SMTP configuration",
							400,
						);
					}
					pass = existing.pass;
				}

				await saveSmtpConfigToDb(emdash.db, encryptionKey, {
					host: body.smtp.host,
					port: body.smtp.port,
					secure: body.smtp.secure,
					user: body.smtp.user,
					pass,
					...(body.smtp.fromName ? { fromName: body.smtp.fromName } : {}),
					...(body.smtp.fromEmail ? { fromEmail: body.smtp.fromEmail } : {}),
					...(body.smtp.replyTo ? { replyTo: body.smtp.replyTo } : {}),
				});

				// Persist and activate SMTP as the selected provider
				await optionsRepo.set(optionKey, SMTP_EMAIL_PLUGIN_ID);
				emdash.hooks.setExclusiveSelection(EMAIL_DELIVER_HOOK, SMTP_EMAIL_PLUGIN_ID);

				return apiSuccess({ success: true, message: "SMTP configured and activated" });
			}

			case "cloudflare": {
				// Save Cloudflare config to DB and select as active provider
				await saveCloudflareConfigToDb(emdash.db, {
					fromName: body.cloudflare.fromName,
					fromEmail: body.cloudflare.fromEmail,
					...(body.cloudflare.replyTo ? { replyTo: body.cloudflare.replyTo } : {}),
				});

				await optionsRepo.set(optionKey, CLOUDFLARE_EMAIL_PLUGIN_ID);
				emdash.hooks.setExclusiveSelection(EMAIL_DELIVER_HOOK, CLOUDFLARE_EMAIL_PLUGIN_ID);
				return apiSuccess({
					success: true,
					message: "Cloudflare Email configured and activated",
				});
			}
		}
	} catch (error) {
		return handleError(error, "Failed to save email settings", "EMAIL_SETTINGS_SAVE_ERROR");
	}
};
