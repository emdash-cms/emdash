import { readFileSync } from "node:fs";

import { validateBlockResponse } from "@emdash-cms/blocks/server";
import { parse } from "jsonc-parser";
import { describe, expect, it, vi } from "vitest";

import plugin from "../src/plugin.js";

// Sandboxed admin responses are validated by the runtime before they reach the
// admin, which answers 502 INVALID_BLOCK_RESPONSE when validation fails. Build
// the same policy the runtime derives from this plugin's manifest.
const manifest = parse(
	readFileSync(new URL("../emdash-plugin.jsonc", import.meta.url), "utf8"),
) as {
	admin: { pages: { path: string }[]; widgets: { id: string }[] };
};
const policy = {
	pluginPagePaths: manifest.admin.pages.map((page) => page.path),
	allowedImageHosts: [],
};

function createCtx(settings: Record<string, unknown> = {}) {
	const kv = new Map(Object.entries(settings));
	return {
		kv: {
			get: vi.fn(async (key: string) => kv.get(key)),
			set: vi.fn(async (key: string, value: unknown) => {
				kv.set(key, value);
			}),
			list: vi.fn(async () => []),
		},
		storage: { deliveries: { count: vi.fn(async () => 0) } },
		http: { fetch: vi.fn(async () => new Response(null, { status: 200 })) },
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
	};
}

async function admin(input: unknown, ctx = createCtx()) {
	// eslint-disable-next-line typescript/no-explicit-any -- exercising the route handler directly
	return (plugin.routes.admin.handler as any)({ input }, ctx);
}

describe("webhook-notifier admin responses", () => {
	it.each([
		["settings page", { type: "page_load", page: "/settings" }],
		["dashboard widget", { type: "page_load", page: `widget:${manifest.admin.widgets[0]!.id}` }],
		[
			"saved settings",
			{
				type: "form_submit",
				action_id: "save_settings",
				values: { webhookUrl: "https://hooks.example.com/emdash", enabled: true },
			},
		],
		["test without a URL", { type: "block_action", action_id: "test_webhook" }],
	])("returns valid Block Kit for the %s", async (_name, input) => {
		const response = await admin(input);
		expect(response.blocks.length).toBeGreaterThan(0);
		expect(validateBlockResponse(response, policy)).toEqual({ valid: true, errors: [] });
	});

	it("returns valid Block Kit after sending a test webhook", async () => {
		const ctx = createCtx({ "settings:webhookUrl": "https://hooks.example.com/emdash" });
		const response = await admin({ type: "block_action", action_id: "test_webhook" }, ctx);
		expect(ctx.http.fetch).toHaveBeenCalledOnce();
		expect(validateBlockResponse(response, policy)).toEqual({ valid: true, errors: [] });
	});

	it("returns valid Block Kit when saving settings fails", async () => {
		const ctx = createCtx();
		ctx.kv.set.mockRejectedValueOnce(new Error("KV unavailable"));
		const response = await admin(
			{
				type: "form_submit",
				action_id: "save_settings",
				values: { webhookUrl: "https://x.example" },
			},
			ctx,
		);
		expect(response.blocks[0]).toMatchObject({ type: "banner", variant: "error" });
		expect(validateBlockResponse(response, policy)).toEqual({ valid: true, errors: [] });
	});

	it("serves the dashboard widget under the id declared in the manifest", async () => {
		const response = await admin({
			type: "page_load",
			page: `widget:${manifest.admin.widgets[0]!.id}`,
		});
		expect(response.blocks[0]).toMatchObject({ type: "fields" });
	});
});
