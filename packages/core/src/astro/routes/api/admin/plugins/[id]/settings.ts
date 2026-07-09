/**
 * Plugin settings endpoint (auto-generated settings UI)
 *
 * GET /_emdash/api/admin/plugins/:id/settings - Get schema + current values (secrets masked)
 * PUT /_emdash/api/admin/plugins/:id/settings - Update values
 */

import type { APIRoute } from "astro";
import { z } from "zod";

import { requirePerm } from "#api/authorize.js";
import { apiError } from "#api/error.js";
import {
	getPluginSettingsSchema,
	handlePluginSettingsGet,
	handlePluginSettingsUpdate,
} from "#api/handlers/plugin-settings.js";
import { unwrapResult } from "#api/index.js";
import { isParseError, parseBody } from "#api/parse.js";

export const prerender = false;

const updateBody = z.object({
	values: z.record(z.string(), z.unknown()),
});

export const GET: APIRoute = async ({ params, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:manage");
	if (denied) return denied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Plugin ID required", 400);
	}

	const schema =
		getPluginSettingsSchema(emdash.configuredPlugins, emdash.sandboxedPluginEntries, id) ??
		emdash.getRuntimePluginSettingsSchema(id);
	if (schema === null) {
		return apiError("NOT_FOUND", `Plugin not found: ${id}`, 404);
	}

	const result = await handlePluginSettingsGet(emdash.db, id, schema);
	return unwrapResult(result);
};

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	const denied = requirePerm(user, "plugins:manage");
	if (denied) return denied;

	if (!id) {
		return apiError("INVALID_REQUEST", "Plugin ID required", 400);
	}

	const schema =
		getPluginSettingsSchema(emdash.configuredPlugins, emdash.sandboxedPluginEntries, id) ??
		emdash.getRuntimePluginSettingsSchema(id);
	if (schema === null) {
		return apiError("NOT_FOUND", `Plugin not found: ${id}`, 404);
	}

	const body = await parseBody(request, updateBody);
	if (isParseError(body)) return body;

	const result = await handlePluginSettingsUpdate(emdash.db, id, schema, body.values);
	return unwrapResult(result);
};
