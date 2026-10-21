import { describe, expect, it } from "vitest";

import { createPlugin } from "../src/index.js";

const routes = createPlugin().routes;

/**
 * Mirrors the core dispatch rule (`packages/core/src/plugins/http-route-dispatch.ts`):
 * a private route without `permission` requires plugins:manage.
 */
function effectivePermission(name: string): string {
	const route = routes[name];
	if (!route) throw new Error(`Route "${name}" is not registered`);
	return route.public ? "public" : (route.permission ?? "plugins:manage");
}

const PUBLIC = ["submit", "definition"];
const EDITOR_READS = [
	"forms/list",
	"submissions/list",
	"submissions/get",
	"settings/turnstile-status",
];
const ADMIN_ONLY = [
	"forms/create",
	"forms/update",
	"forms/delete",
	"forms/duplicate",
	"submissions/update",
	"submissions/delete",
	"submissions/export",
];

describe("forms plugin route permissions", () => {
	it("keeps the submit and definition routes public", () => {
		for (const name of PUBLIC) expect(effectivePermission(name), name).toBe("public");
	});

	it("lets editors (plugins:read) read forms and submissions", () => {
		for (const name of EDITOR_READS) expect(effectivePermission(name), name).toBe("plugins:read");
	});

	it("keeps writes and the bulk export admin-only", () => {
		for (const name of ADMIN_ONLY) expect(effectivePermission(name), name).toBe("plugins:manage");
	});

	it("classifies every registered route", () => {
		expect(Object.keys(routes).toSorted()).toEqual(
			[...PUBLIC, ...EDITOR_READS, ...ADMIN_ONLY].toSorted(),
		);
	});
});
