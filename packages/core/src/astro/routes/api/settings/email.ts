/**
 * Email Settings API endpoint
 *
 * GET  /_emdash/api/settings/email: current provider, available providers, middleware
 * POST /_emdash/api/settings/email: send a test email through the full pipeline
 * PUT  /_emdash/api/settings/email: save SMTP settings or select the provider
 */

import { escapeHtml } from "@emdash-cms/auth";
import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { OptionsRepository } from "#db/repositories/options.js";
import {
	loadSmtpConfigFromDb,
	isSmtpEnvConfigured,
	loadSmtpConfigFromEnv,
	saveSmtpConfigToDb,
	SMTP_EMAIL_PLUGIN_ID,
	SmtpDeliveryError,
	type SmtpConfig,
} from "#plugins/email-smtp.js";

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
		// Env-configured SMTP can be selected in memory only, without a stored option.
		const selectedProviderId =
			(await optionsRepo.get<string>(`emdash:exclusive_hook:${EMAIL_DELIVER_HOOK}`)) ??
			pipeline.getExclusiveSelection(EMAIL_DELIVER_HOOK);

		// Get middleware hooks (beforeSend / afterSend). These are non-exclusive —
		// many plugins can subscribe — so we enumerate non-exclusive providers.
		const beforeSendPlugins = pipeline
			.getHookProviders(EMAIL_BEFORE_SEND_HOOK)
			.map((p) => p.pluginId);
		const afterSendPlugins = pipeline
			.getHookProviders(EMAIL_AFTER_SEND_HOOK)
			.map((p) => p.pluginId);

		// SMTP transport status: DB config takes precedence over env vars
		let smtpStatus: {
			configured: boolean;
			source: "db" | "env" | null;
			host?: string;
			port?: number;
			secure?: "starttls" | "tls";
			user?: string;
			fromName?: string;
			fromEmail?: string;
			replyTo?: string;
		} = { configured: false, source: null };
		const encryptionKey = process.env.EMDASH_ENCRYPTION_KEY;
		const dbConfig = encryptionKey ? await loadSmtpConfigFromDb(emdash.db, encryptionKey) : null;
		let envConfig: SmtpConfig | null = null;
		if (!dbConfig) {
			try {
				envConfig = loadSmtpConfigFromEnv();
			} catch {
				// Shown as unconfigured; the runtime logs why the env config is ignored.
			}
		}
		const smtpConfig = dbConfig ?? envConfig;
		if (smtpConfig) {
			smtpStatus = {
				configured: true,
				source: dbConfig ? "db" : "env",
				host: smtpConfig.host,
				port: smtpConfig.port,
				secure: smtpConfig.secure,
				user: smtpConfig.user,
				...(smtpConfig.fromName ? { fromName: smtpConfig.fromName } : {}),
				...(smtpConfig.fromEmail ? { fromEmail: smtpConfig.fromEmail } : {}),
				...(smtpConfig.replyTo ? { replyTo: smtpConfig.replyTo } : {}),
			};
		}

		return apiSuccess({
			available: emdash.email?.isAvailable() ?? false,
			providers: providers.map((p) => ({
				pluginId: p.pluginId,
			})),
			selectedProviderId: selectedProviderId ?? null,
			middleware: {
				beforeSend: beforeSendPlugins,
				afterSend: afterSendPlugins,
			},
			smtp: smtpStatus,
		});
	} catch (error) {
		return handleError(error, "Failed to get email settings", "EMAIL_SETTINGS_READ_ERROR");
	}
};

/**
 * POST /_emdash/api/settings/email
 *
 * Send a test email through the full pipeline.
 * Validates the pipeline is configured and the provider works.
 */
const testEmailBody = z.object({
	to: z.email(),
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
			"No email provider is configured. Configure SMTP or activate an email provider plugin.",
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
		if (error instanceof SmtpDeliveryError) {
			console.error("[EMAIL_TEST_ERROR]", error);
			return apiError("EMAIL_TEST_ERROR", `Failed to send test email: ${error.message}`, 502);
		}
		return handleError(error, "Failed to send test email", "EMAIL_TEST_ERROR");
	}
};

// ---------------------------------------------------------------------------
// PUT /_emdash/api/settings/email: configure email provider
// ---------------------------------------------------------------------------

const smtpConfigSchema = z.object({
	host: z.string().min(1),
	port: z
		.number()
		.int()
		.min(1)
		.max(65535)
		.refine((p) => p !== 25, {
			message: "Port 25 is not supported. Use 587 (STARTTLS) or 465 (implicit TLS) instead.",
		}),
	secure: z.enum(["starttls", "tls"]),
	user: z.string().min(1),
	pass: z.string().min(1).optional(), // undefined = keep existing password
	fromName: z.string().optional(),
	fromEmail: z.string().email().optional(),
	replyTo: z.string().email().optional(),
});

const emailSettingsBody = z.discriminatedUnion("provider", [
	// Without `smtp`, selects SMTP configured through environment variables.
	z.object({ provider: z.literal("smtp"), smtp: smtpConfigSchema.optional() }),
	z.object({ provider: z.literal("plugin"), pluginId: z.string().min(1) }),
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

		const encryptionKey = process.env.EMDASH_ENCRYPTION_KEY;
		const optionsRepo = new OptionsRepository(emdash.db);
		const optionKey = `emdash:exclusive_hook:${EMAIL_DELIVER_HOOK}`;

		switch (body.provider) {
			case "smtp": {
				if (!body.smtp) {
					const saved = encryptionKey ? await loadSmtpConfigFromDb(emdash.db, encryptionKey) : null;
					if (!saved && !isSmtpEnvConfigured()) {
						return apiError("VALIDATION_ERROR", "SMTP settings are required", 400);
					}
					await optionsRepo.set(optionKey, SMTP_EMAIL_PLUGIN_ID);
					emdash.hooks.setExclusiveSelection(EMAIL_DELIVER_HOOK, SMTP_EMAIL_PLUGIN_ID);
					return apiSuccess({ success: true, message: "SMTP activated" });
				}
				if (!encryptionKey) {
					return apiError(
						"ENCRYPTION_KEY_MISSING",
						"EMDASH_ENCRYPTION_KEY is required to store SMTP credentials securely",
						500,
					);
				}

				// The saved password is only reused for the same server and login, so
				// it cannot be sent to a host chosen by someone who never knew it.
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
					if (existing.host !== body.smtp.host || existing.user !== body.smtp.user) {
						return apiError(
							"VALIDATION_ERROR",
							"Re-enter the password when changing the SMTP host or username",
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

				await optionsRepo.set(optionKey, SMTP_EMAIL_PLUGIN_ID);
				emdash.hooks.setExclusiveSelection(EMAIL_DELIVER_HOOK, SMTP_EMAIL_PLUGIN_ID);

				return apiSuccess({ success: true, message: "SMTP configured and activated" });
			}

			case "plugin": {
				if (body.pluginId === SMTP_EMAIL_PLUGIN_ID) {
					return apiError("VALIDATION_ERROR", "Use the smtp provider variant for SMTP", 400);
				}
				const registered = emdash.hooks
					.getExclusiveHookProviders(EMAIL_DELIVER_HOOK)
					.some((p) => p.pluginId === body.pluginId);
				if (!registered) {
					return apiError("VALIDATION_ERROR", "Unknown email provider", 400);
				}
				await optionsRepo.set(optionKey, body.pluginId);
				emdash.hooks.setExclusiveSelection(EMAIL_DELIVER_HOOK, body.pluginId);
				return apiSuccess({ success: true, message: "Email provider updated" });
			}

			default: {
				const exhaustive: never = body;
				return exhaustive;
			}
		}
	} catch (error) {
		return handleError(error, "Failed to save email settings", "EMAIL_SETTINGS_SAVE_ERROR");
	}
};
