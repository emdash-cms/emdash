/**
 * POST /_emdash/api/setup/admin/email
 *
 * Complete setup for email-based sign-in:
 * - Creates the initial admin user
 * - Marks setup complete
 * - Sends the first magic link email
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { Role, sendMagicLink, type MagicLinkConfig } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getSiteBaseUrl } from "#api/site-url.js";
import { OptionsRepository } from "#db/repositories/options.js";

interface SetupAdminState {
	step: "admin";
	email: string;
	name?: string | null;
}

function isSetupAdminState(value: unknown): value is SetupAdminState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- runtime guards above
	const record = value as Record<string, unknown>;
	if (record.step !== "admin") return false;
	if (typeof record.email !== "string" || !record.email) return false;
	if (record.name !== undefined && record.name !== null && typeof record.name !== "string") return false;
	return true;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	if (!emdash.email?.isAvailable()) {
		return apiError(
			"EMAIL_NOT_CONFIGURED",
			"Email sign-in requires an email provider to be configured.",
			400,
		);
	}

	try {
		const options = new OptionsRepository(emdash.db);
		const setupComplete = await options.get("emdash:setup_complete");

		if (setupComplete === true || setupComplete === "true") {
			return apiError("SETUP_COMPLETE", "Setup already complete", 400);
		}

		const setupState = await options.get("emdash:setup_state");
		if (!isSetupAdminState(setupState)) {
			return apiError("INVALID_STATE", "Invalid setup state. Please restart setup.", 400);
		}

		const adapter = createKyselyAdapter(emdash.db);
		const userCount = await adapter.countUsers();
		if (userCount > 0) {
			return apiError("ADMIN_EXISTS", "Admin user already exists", 400);
		}

		const user = await adapter.createUser({
			email: setupState.email,
			name: setupState.name ?? null,
			role: Role.ADMIN,
			emailVerified: false,
		});

		await options.set("emdash:setup_complete", true);
		await options.delete("emdash:setup_state");

		const siteName = (await options.get<string>("emdash:site_title")) ?? "EmDash";
		const baseUrl = await getSiteBaseUrl(emdash.db, request);
		const config: MagicLinkConfig = {
			baseUrl,
			siteName,
			email: (message) => emdash.email!.send(message, "system"),
		};

		let emailSent = true;
		try {
			await sendMagicLink(config, adapter, user.email);
		} catch (error) {
			emailSent = false;
			console.error("Setup email sign-in: failed to send initial magic link:", error);
		}

		return apiSuccess({
			success: true,
			emailSent,
			message: emailSent
				? "Setup complete. Check your email for a sign-in link."
				: "Setup complete. Use email sign-in from the login page.",
		});
	} catch (error) {
		return handleError(error, "Failed to complete email setup", "SETUP_ADMIN_EMAIL_ERROR");
	}
};
