import { describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({ defineMiddleware: (handler: unknown) => handler }));

function echo(name: string, methods: string[]) {
	const handler = (context: { params: Record<string, string | undefined> }) =>
		Response.json({ name, params: context.params });
	return Object.fromEntries(
		["GET", "HEAD", "POST", "PUT", "DELETE"].map((method) => [
			method,
			methods.includes(method) ? vi.fn(handler) : undefined,
		]),
	);
}

vi.mock("../../../src/astro/routes/api/admin/transfer/capabilities.js", () =>
	echo("capabilities", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/approvals/index.js", () =>
	echo("approvals", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/approvals/[id]/approve.js", () =>
	echo("approve", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/approvals/[id]/deny.js", () =>
	echo("deny", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/exports/index.js", () =>
	echo("exports", ["GET", "POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/exports/[id]/index.js", () =>
	echo("export", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/exports/[id]/advance.js", () =>
	echo("export-advance", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/exports/[id]/manifest.js", () =>
	echo("export-manifest", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/exports/[id]/archive.js", () =>
	echo("export-archive", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/exports/[id]/files/[...path].js", () =>
	echo("export-file", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/index.js", () =>
	echo("imports", ["GET", "POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/index.js", () =>
	echo("import", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/missing.js", () =>
	echo("import-missing", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/files/[...path].js", () =>
	echo("import-file", ["PUT"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/analyze.js", () =>
	echo("import-analyze", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/plan.js", () =>
	echo("import-plan", ["GET"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/cancel.js", () =>
	echo("import-cancel", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/abandon.js", () =>
	echo("import-abandon", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/execute.js", () =>
	echo("import-execute", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/advance.js", () =>
	echo("import-advance", ["POST"]),
);
vi.mock("../../../src/astro/routes/api/admin/transfer/imports/[id]/receipt.js", () =>
	echo("import-receipt", ["GET"]),
);

const { injectCoreRoutes } = await import("../../../src/astro/integration/routes.js");
const dispatch = await import("../../../src/astro/routes/api/admin/transfer/[...path].js");

async function call(method: "GET" | "POST" | "PUT" | "DELETE", path: string): Promise<Response> {
	// eslint-disable-next-line typescript/no-explicit-any -- test double for APIContext
	const context: any = {
		params: { path },
		request: new Request(`https://example.com/_emdash/api/admin/transfer/${path}`, { method }),
		locals: {},
	};
	return dispatch[method](context);
}

describe("site transfer route", () => {
	it("is registered as a single catch-all route", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);
		const patterns = injectRoute.mock.calls
			.map((args) => (args[0] as { pattern: string }).pattern)
			.filter((pattern) => pattern.startsWith("/_emdash/api/admin/transfer"));
		expect(patterns).toEqual(["/_emdash/api/admin/transfer/[...path]"]);
	});

	it.each([
		["GET", "capabilities", "capabilities", {}],
		["GET", "approvals", "approvals", {}],
		["POST", "approvals/01A/approve", "approve", { id: "01A" }],
		["POST", "approvals/01A/deny", "deny", { id: "01A" }],
		["GET", "exports", "exports", {}],
		["POST", "exports", "exports", {}],
		["GET", "exports/01E", "export", { id: "01E" }],
		["POST", "exports/01E/advance", "export-advance", { id: "01E" }],
		["GET", "exports/01E/manifest", "export-manifest", { id: "01E" }],
		["GET", "exports/01E/archive", "export-archive", { id: "01E" }],
		[
			"GET",
			"exports/01E/files/records/entry/000001.ndjson",
			"export-file",
			{ id: "01E", path: "records/entry/000001.ndjson" },
		],
		["GET", "imports", "imports", {}],
		["POST", "imports", "imports", {}],
		["GET", "imports/01I", "import", { id: "01I" }],
		["GET", "imports/01I/missing", "import-missing", { id: "01I" }],
		["PUT", "imports/01I/files/media/abc", "import-file", { id: "01I", path: "media/abc" }],
		["POST", "imports/01I/analyze", "import-analyze", { id: "01I" }],
		["GET", "imports/01I/plan", "import-plan", { id: "01I" }],
		["POST", "imports/01I/cancel", "import-cancel", { id: "01I" }],
		["POST", "imports/01I/abandon", "import-abandon", { id: "01I" }],
		["POST", "imports/01I/execute", "import-execute", { id: "01I" }],
		["POST", "imports/01I/advance", "import-advance", { id: "01I" }],
		["GET", "imports/01I/receipt", "import-receipt", { id: "01I" }],
	])("routes %s %s to its endpoint", async (method, path, name, params) => {
		const response = await call(method as Parameters<typeof call>[0], path);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ name, params });
	});

	it("rejects a method the endpoint doesn't handle", async () => {
		const response = await call("DELETE", "imports/01I");
		expect(response.status).toBe(405);
	});

	it.each(["", "unknown", "imports/01I/unknown", "exports/01E/files", "imports//plan"])(
		"returns 404 for %j",
		async (path) => {
			expect((await call("GET", path)).status).toBe(404);
		},
	);
});
