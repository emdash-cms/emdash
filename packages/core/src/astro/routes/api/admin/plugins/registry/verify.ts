import { hostEnvFromVersions } from "@emdash-cms/registry-client/env";
import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleRegistryInstall } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";

import { VERSION } from "../../../../../../version.js";

export const prerender = false;

const verifyBodySchema = z.object({
	did: z
		.string()
		.min(1)
		.max(2048)
		.regex(/^did:[a-z]+:/, "Invalid DID"),
	slug: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Invalid slug"),
	version: z.string().min(1).max(64).optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
	try {
		const { emdash, user } = locals;
		if (!emdash?.db) {
			return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
		}
		const denied = requirePerm(user, "plugins:manage");
		if (denied) return denied;
		const body = await parseBody(request, verifyBodySchema);
		if (isParseError(body)) return body;

		const reservedPluginIds = new Set<string>([
			...emdash.configuredPlugins.map((plugin: { id: string }) => plugin.id),
			...(emdash.config.sandboxed ?? []).map((plugin: { id: string }) => plugin.id),
		]);
		const result = await handleRegistryInstall(
			emdash.db,
			emdash.storage,
			emdash.getSandboxRunner(),
			emdash.config.experimental?.registry,
			body,
			{
				configuredPluginIds: reservedPluginIds,
				hostEnv: hostEnvFromVersions(VERSION, emdash.config.astroVersion),
				verifyOnly: true,
			},
		);
		return unwrapResult(result);
	} catch (error) {
		console.error("[registry-verify] Unhandled error:", error);
		return handleError(error, "Failed to verify registry plugin", "VERIFICATION_FAILED");
	}
};
