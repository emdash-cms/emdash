/**
 * Registry plugin install endpoint
 *
 * POST /_emdash/api/admin/plugins/registry/install
 *
 * Installs a plugin from the experimental decentralized plugin registry
 * (see RFC 0001). The browser passes the publisher handle and slug it
 * resolved through the aggregator's `searchPackages` / `resolvePackage`
 * endpoints; the server re-resolves and re-verifies on its side before
 * fetching the artifact and handing it to the sandbox loader.
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError, handleError, unwrapResult } from "#api/error.js";
import { handleRegistryInstall } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";

export const prerender = false;

const installBodySchema = z.object({
	/** Publisher's atproto handle (e.g. `"example.dev"`). */
	handle: z.string().min(1).max(253),
	/** Package slug. */
	slug: z
		.string()
		.min(1)
		.max(64)
		// Mirrors the lexicon's slug grammar: ASCII letter followed by
		// letters / digits / `-` / `_`. Rejects anything that could
		// confuse the R2 prefix or the URL.
		.regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, "Invalid slug"),
	/** Optional explicit version. Defaults to the aggregator's latest. */
	version: z.string().min(1).max(64).optional(),
	/**
	 * Capabilities the admin acknowledged in the consent dialog, lifted
	 * from the release record's declaredAccess block at browse time.
	 * Compared against the bundle's manifest to detect drift between the
	 * dialog and the install POST.
	 */
	acknowledgedDeclaredAccess: z.unknown().optional(),
});

export const POST: APIRoute = async ({ request, locals }) => {
	try {
		const { emdash, user } = locals;

		if (!emdash?.db) {
			return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
		}

		const denied = requirePerm(user, "plugins:manage");
		if (denied) return denied;

		const body = await parseBody(request, installBodySchema);
		if (isParseError(body)) return body;

		// Block registry installs whose derived `pluginId` collides with
		// any build-time-reserved id: configured (in-process) plugins, and
		// sandboxed plugins declared in `config.sandboxed`. The runtime
		// caches sandboxed plugins by id; a registry install at the same
		// id would silently shadow or coexist with the build-time entry.
		const reservedPluginIds = new Set<string>([
			...emdash.configuredPlugins.map((p: { id: string }) => p.id),
			...(emdash.config.sandboxed ?? []).map((p: { id: string }) => p.id),
		]);

		const result = await handleRegistryInstall(
			emdash.db,
			emdash.storage,
			emdash.getSandboxRunner(),
			emdash.config.experimental?.registry,
			{
				handle: body.handle,
				slug: body.slug,
				version: body.version,
				acknowledgedDeclaredAccess: body.acknowledgedDeclaredAccess,
			},
			{ configuredPluginIds: reservedPluginIds },
		);

		if (!result.success) return unwrapResult(result);

		// Sync runtime so the new plugin becomes active without a worker restart.
		await emdash.syncRegistryPlugins();

		return unwrapResult(result, 201);
	} catch (error) {
		console.error("[registry-install] Unhandled error:", error);
		return handleError(error, "Failed to install plugin from registry", "INSTALL_FAILED");
	}
};
