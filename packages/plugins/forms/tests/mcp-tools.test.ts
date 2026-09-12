import { describe, expect, it } from "vitest";

import { createPlugin } from "../src/index.js";

const expectedTools = {
	listForms: { route: "forms/list", destructive: false },
	createForm: { route: "forms/create", destructive: false },
	updateForm: { route: "forms/update", destructive: true },
	deleteForm: { route: "forms/delete", destructive: true },
	duplicateForm: { route: "forms/duplicate", destructive: false },
	listSubmissions: { route: "submissions/list", destructive: false },
	getSubmission: { route: "submissions/get", destructive: false },
	updateSubmission: { route: "submissions/update", destructive: true },
	deleteSubmission: { route: "submissions/delete", destructive: true },
	exportSubmissions: { route: "submissions/export", destructive: false },
} as const;

describe("forms plugin MCP tools", () => {
	it("exposes all private form operations as admin-only tools", () => {
		const plugin = createPlugin();
		const tools = plugin.mcp?.tools;

		expect(Object.keys(tools ?? {})).toEqual(Object.keys(expectedTools));

		for (const [name, expected] of Object.entries(expectedTools)) {
			const tool = tools?.[name];
			const route = plugin.routes[expected.route];

			expect(tool, `${name} MCP definition`).toBeDefined();
			expect(tool?.route).toBe(expected.route);
			expect(tool?.destructive).toBe(expected.destructive);
			expect(tool?.description.length).toBeGreaterThan(0);
			expect(tool?.input).toBe(route?.input);
			expect(route?.permission).toBe("plugins:manage");
		}
	});
});
