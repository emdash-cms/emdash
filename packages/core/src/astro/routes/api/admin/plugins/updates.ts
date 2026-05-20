/**
 * Plugin update check endpoint
 *
 * GET /_emdash/api/admin/plugins/updates - Check for available updates
 * across every installed plugin source (marketplace + experimental registry).
 * Items are returned in a single flat list so the admin issues one query
 * regardless of source mix; consumers tell sources apart by pluginId
 * (registry ids are `r_*` per `REGISTRY_PLUGIN_ID_PATTERN`).
 *
 * A failure in one source does NOT blank the other — a registry-side
 * aggregator outage still returns marketplace updates and vice versa.
 */

import type { APIRoute } from "astro";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import { handleMarketplaceUpdateCheck, handleRegistryUpdateCheck } from "#api/index.js";

export const prerender = false;

export const GET: APIRoute = async ({ locals }) => {
	const { emdash, user } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:read");
	if (denied) return denied;

	// Run both checks in parallel. Catch each independently so one source's
	// failure doesn't blank the other. Both throws and structured `success:
	// false` returns are logged with the source name so a misconfigured
	// registry doesn't disappear silently from telemetry.
	const [marketplace, registry] = await Promise.all([
		handleMarketplaceUpdateCheck(emdash.db, emdash.config.marketplace).catch((err) => {
			console.warn("[plugins/updates] marketplace check threw:", err);
			return null;
		}),
		handleRegistryUpdateCheck(emdash.db, emdash.config.experimental?.registry).catch((err) => {
			console.warn("[plugins/updates] registry check threw:", err);
			return null;
		}),
	]);
	if (marketplace && !marketplace.success) {
		console.warn(
			`[plugins/updates] marketplace check failed: ${marketplace.error.code} ${marketplace.error.message}`,
		);
	}
	if (registry && !registry.success) {
		console.warn(
			`[plugins/updates] registry check failed: ${registry.error.code} ${registry.error.message}`,
		);
	}

	const items: unknown[] = [];
	if (marketplace?.success) items.push(...marketplace.data.items);
	if (registry?.success) items.push(...registry.data.items);

	// Match the rest of the admin API envelope (`{ data: ... }`) so the
	// admin client's `parseApiResponse` unwraps `body.data`.
	return Response.json({ data: { items } });
};
