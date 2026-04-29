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
		return handleError(error, "Failed to send test email", "EMAIL_TEST_ERROR");
	}
};
