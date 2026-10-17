import { describe, expect, it, vi } from "vitest";

import { formsListHandler } from "../src/handlers/forms.js";
import { createPlugin } from "../src/index.js";

describe("forms MCP tools", () => {
	const plugin = createPlugin();
	const tools = Object.entries(plugin.mcp?.tools ?? {});

	it("offers reading forms and submissions, and triaging a submission", () => {
		expect(tools.map(([name]) => name).toSorted()).toEqual([
			"forms_list",
			"submissions_get",
			"submissions_list",
			"submissions_update",
		]);
	});

	it("binds every tool to a private JSON POST route that names its permission", () => {
		// The runtime drops a tool silently when any of these fails, so a typo in a
		// route name or a missing permission would ship as a tool that never appears.
		for (const [name, tool] of tools) {
			const route = plugin.routes[tool.route];
			expect(route, `${name} -> ${tool.route}`).toBeDefined();
			expect(route?.public ?? false, name).toBe(false);
			expect(route?.permission, name).toBeTypeOf("string");
			expect(route?.response, name).not.toBe("raw");
			expect(route?.methods === undefined || route.methods.includes("POST"), name).toBe(true);
			expect(route?.request === undefined || route.request.body === "json", name).toBe(true);
		}
	});

	it("keeps the REST permission where it was", () => {
		for (const [, tool] of tools) {
			expect(plugin.routes[tool.route]?.permission).toBe("plugins:manage");
		}
	});

	it("does not offer deleting, exporting or editing forms", () => {
		const bound = new Set(tools.map(([, tool]) => tool.route));
		for (const route of [
			"submissions/delete",
			"submissions/export",
			"forms/create",
			"forms/update",
			"forms/delete",
			"forms/duplicate",
		]) {
			expect(bound.has(route), route).toBe(false);
		}
	});

	it("lets a caller page through the forms list, and keeps an empty body working", async () => {
		const input = plugin.routes["forms/list"]?.input;
		// The admin sends `{}` and some callers send nothing; both get the first 100.
		expect(input?.parse(undefined)).toEqual({ limit: 100 });
		expect(input?.parse({})).toEqual({ limit: 100 });
		expect(input?.parse({ limit: 10, cursor: "abc" })).toEqual({ limit: 10, cursor: "abc" });
		expect(input?.safeParse({ limit: 101 }).success).toBe(false);

		const query = vi.fn().mockResolvedValue({ items: [], hasMore: false, cursor: undefined });
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- only storage.forms.query is read
		const ctx = {
			input: { limit: 10, cursor: "abc" },
			storage: { forms: { query } },
		} as unknown as Parameters<typeof formsListHandler>[0];
		await formsListHandler(ctx);
		expect(query).toHaveBeenCalledWith({
			orderBy: { createdAt: "desc" },
			limit: 10,
			cursor: "abc",
		});
	});

	it("marks no tool destructive, since none removes or overwrites visitor data", () => {
		for (const [name, tool] of tools) expect(tool.destructive, name).toBe(false);
	});
});
