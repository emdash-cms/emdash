import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	DELETE as deleteById,
	PUT as putById,
} from "../../../src/astro/routes/api/admin/bylines/[id]/index.js";
import { POST as createByline } from "../../../src/astro/routes/api/admin/bylines/index.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { HookPipeline } from "../../../src/plugins/hooks.js";
import type { PluginCapability, ResolvedPlugin } from "../../../src/plugins/types.js";
import { connectMcpHarness, extractJson } from "../../utils/mcp-runtime.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function hook(pluginId: string, handler: (...args: unknown[]) => Promise<void>) {
	return {
		pluginId,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue" as const,
		exclusive: false,
	};
}

function plugin(
	id: string,
	capabilities: PluginCapability[],
	handlers: { save: () => Promise<void>; remove: () => Promise<void> },
): ResolvedPlugin {
	return {
		id,
		version: "1.0.0",
		capabilities,
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [] },
		hooks: {
			"byline:afterSave": hook(id, handlers.save),
			"byline:afterDelete": hook(id, handlers.remove),
		},
		routes: {},
	};
}

describe("byline hooks", () => {
	let db: Kysely<Database>;
	let hooks: HookPipeline;
	const save = vi.fn(async () => {});
	const remove = vi.fn(async () => {});
	const unauthorized = vi.fn(async () => {});

	function call(route: typeof putById, method: string, id: string | null, body?: unknown) {
		const path = id ? `/_emdash/api/admin/bylines/${id}` : "/_emdash/api/admin/bylines";
		const request = new Request(`http://localhost${path}`, {
			method,
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
		const context = {
			params: id ? { id } : {},
			url: new URL(request.url),
			request,
			locals: { emdash: { db, hooks, config: {} }, user: { id: "admin", role: Role.ADMIN } },
		} as unknown as APIContext;
		return route(context);
	}

	beforeEach(async () => {
		db = await setupTestDatabase();
		save.mockClear();
		remove.mockClear();
		unauthorized.mockClear();
		const failing = vi.fn(async () => {
			throw new Error("plugin failure");
		});
		hooks = new HookPipeline(
			[
				plugin("failing", ["bylines:read"], { save: failing, remove: failing }),
				plugin("indexer", ["bylines:read"], { save, remove }),
				plugin("no-capability", ["content:read", "users:read"], {
					save: unauthorized,
					remove: unauthorized,
				}),
			],
			{ db },
		);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("notifies bylines:read plugins of creates, updates, and deletes with public fields", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const user = await new UserRepository(db).create({
			email: "jane@example.com",
			displayName: "Jane",
			role: "editor",
		});

		const created = await call(createByline, "POST", null, {
			slug: "jane",
			displayName: "Jane",
			userId: user.id,
		});
		expect(created.status).toBe(201);
		const { data } = (await created.json()) as { data: { id: string } };
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
		expect(save).toHaveBeenLastCalledWith(
			{ byline: expect.objectContaining({ id: data.id, displayName: "Jane" }), isNew: true },
			expect.anything(),
		);
		expect(save.mock.lastCall![0]).not.toHaveProperty("byline.userId");

		expect((await call(putById, "PUT", data.id, { displayName: "Jane Doe" })).status).toBe(200);
		await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
		expect(save).toHaveBeenLastCalledWith(
			{ byline: expect.objectContaining({ displayName: "Jane Doe" }), isNew: false },
			expect.anything(),
		);

		expect((await call(deleteById, "DELETE", data.id)).status).toBe(200);
		await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
		expect(remove).toHaveBeenLastCalledWith(
			{ byline: expect.objectContaining({ id: data.id, slug: "jane" }) },
			expect.anything(),
		);
		expect(await new BylineRepository(db).findById(data.id)).toBeNull();
		expect(unauthorized).not.toHaveBeenCalled();
	});

	it("notifies plugins of MCP creates, updates, and deletes", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		const plugins = [plugin("indexer", ["bylines:read"], { save, remove })];
		const harness = await connectMcpHarness({
			db,
			userId: "admin",
			userRole: Role.ADMIN,
			runtimeOptions: { plugins },
		});
		try {
			const created = await harness.client.callTool({
				name: "byline_create",
				arguments: { slug: "mcp", displayName: "MCP" },
			});
			const { id } = extractJson<{ id: string }>(created);
			await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
			expect(save.mock.lastCall![0]).toMatchObject({ byline: { id }, isNew: true });

			await harness.client.callTool({
				name: "byline_update",
				arguments: { id, displayName: "MCP 2" },
			});
			await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
			expect(save.mock.lastCall![0]).toMatchObject({ isNew: false });

			await harness.client.callTool({ name: "byline_delete", arguments: { id } });
			await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
			expect(remove.mock.lastCall![0]).toMatchObject({ byline: { id, slug: "mcp" } });
		} finally {
			await harness.cleanup();
		}
	});
});
