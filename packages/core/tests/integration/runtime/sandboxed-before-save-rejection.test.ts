import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PUT as updateContentRoute } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { POST as createContentRoute } from "../../../src/astro/routes/api/content/[collection]/index.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH } from "../../../src/plugins/sandbox/hook-result.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const rejection = {
	__emdashSandboxHookResult: true,
	version: 1,
	error: { code: "SAVE_REJECTED", reason: "Posts need a summary" },
};
const invokeHook = vi.fn<SandboxedPluginInstance["invokeHook"]>();

function createDeps(sqlite: Database.Database): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({
			id: "editorial-gate:1.0.0",
			invokeHook,
			invokeRoute: vi.fn(),
			terminate: vi.fn(),
		}),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};
	return {
		config: {
			database: {
				entrypoint: `test-sandboxed-before-save-rejection-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [],
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: "editorial-gate",
				version: "1.0.0",
				options: {},
				code: "",
				capabilities: ["content:read", "content:write"],
				allowedHosts: [],
				storage: {},
			},
		],
		// eslint-disable-next-line typescript/no-explicit-any -- test fake implements the published runner boundary without platform setup
		createSandboxRunner: (() => runner) as any,
	};
}

function routeContext(runtime: EmDashRuntime, request: Request, id?: string): APIContext {
	return {
		params: id ? { collection: "post", id } : { collection: "post" },
		request,
		url: new URL(request.url),
		locals: { emdash: runtime, user: { id: "editor-1", role: Role.ADMIN } },
		cache: { enabled: false, invalidate: vi.fn() },
	} as unknown as APIContext;
}

describe("sandboxed content:beforeSave cancellation", () => {
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	beforeAll(async () => {
		runtime = await EmDashRuntime.create(createDeps(new Database(":memory:")));
		const registry = new SchemaRegistry(runtime.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		repo = new ContentRepository(runtime.db);
	});

	beforeEach(() => {
		invokeHook.mockReset();
	});

	afterAll(async () => {
		await runtime?.stopCron();
	});

	describe("valid SAVE_REJECTED envelope", () => {
		beforeEach(() => invokeHook.mockResolvedValue(rejection));

		it("returns a stable 422 response and does not persist a create", async () => {
			const beforeCount = (await repo.findMany("post")).items.length;
			const request = new Request("http://localhost/_emdash/api/content/post", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Hi" } }),
			});

			const response = await createContentRoute(routeContext(runtime, request));

			expect(response.status).toBe(422);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "SAVE_REJECTED",
					message: "Save rejected by a sandboxed plugin",
					details: { pluginId: "editorial-gate", reason: "Posts need a summary" },
				},
			});
			expect((await repo.findMany("post")).items).toHaveLength(beforeCount);
		});

		it("returns a stable 422 response and preserves the stored update", async () => {
			const item = await repo.create({
				type: "post",
				data: { title: "Original" },
				authorId: "editor-1",
			});
			const request = new Request(`http://localhost/_emdash/api/content/post/${item.id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ data: { title: "Changed" } }),
			});

			const response = await updateContentRoute(routeContext(runtime, request, item.id));

			expect(response.status).toBe(422);
			expect(await response.json()).toMatchObject({
				success: false,
				error: {
					code: "SAVE_REJECTED",
					details: { pluginId: "editorial-gate", reason: "Posts need a summary" },
				},
			});
			expect((await repo.findById("post", item.id))?.data.title).toBe("Original");
		});
	});

	it.each([
		["empty reason", { ...rejection, error: { ...rejection.error, reason: "" } }],
		[
			"overlong reason",
			{
				...rejection,
				error: {
					...rejection.error,
					reason: "x".repeat(MAX_SANDBOX_SAVE_REJECTION_REASON_LENGTH + 1),
				},
			},
		],
		["malformed reason", { ...rejection, error: { ...rejection.error, reason: 42 } }],
		["unknown error", { ...rejection, error: { code: "NOPE", reason: "internal" } }],
	])("maps a %s envelope to a generic error without persisting", async (_label, envelope) => {
		invokeHook.mockResolvedValue(envelope);
		const beforeCount = (await repo.findMany("post")).items.length;

		const result = await runtime.handleContentCreate("post", { data: { title: "Hi" } });

		expect(result).toEqual({
			success: false,
			error: { code: "CONTENT_HOOK_ERROR", message: "A plugin hook failed while saving content" },
		});
		expect(JSON.stringify(result)).not.toContain("internal");
		expect((await repo.findMany("post")).items).toHaveLength(beforeCount);
	});

	it("masks an unexpected thrown exception and does not persist", async () => {
		const error = new Error("secret sandbox detail");
		error.stack = "secret sandbox stack";
		invokeHook.mockRejectedValue(error);
		const beforeCount = (await repo.findMany("post")).items.length;

		const result = await runtime.handleContentCreate("post", { data: { title: "Hi" } });

		expect(result).toEqual({
			success: false,
			error: { code: "CONTENT_HOOK_ERROR", message: "A plugin hook failed while saving content" },
		});
		expect(JSON.stringify(result)).not.toContain("secret sandbox detail");
		expect(JSON.stringify(result)).not.toContain("secret sandbox stack");
		expect((await repo.findMany("post")).items).toHaveLength(beforeCount);
	});
});
