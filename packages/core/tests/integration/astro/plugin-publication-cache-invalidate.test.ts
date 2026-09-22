import { randomUUID } from "node:crypto";

import { Role } from "@emdash-cms/auth";
import Database from "better-sqlite3";
import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "../../../src/astro/routes/api/plugins/[pluginId]/[...path].js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { RouteContext } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

let targetSlug = "";

function publicationPlugin() {
	const publish = async (ctx: RouteContext) => {
		if (!ctx.content?.getVersioned || !ctx.content.publish) {
			throw new Error("Publication access unavailable");
		}
		const current = await ctx.content.getVersioned("post", targetSlug);
		if (!current) throw new Error("Content not found");
		return ctx.content.publish("post", targetSlug, { _rev: current._rev });
	};

	return definePlugin({
		id: "publication-route",
		version: "1.0.0",
		capabilities: ["content:publish"],
		routes: {
			publish: { handler: publish },
			"publish-then-fail": {
				handler: async (ctx) => {
					await publish(ctx);
					throw new Error("response failed after publication");
				},
			},
		},
	});
}

function createDeps(): RuntimeDependencies {
	const plugin = publicationPlugin();
	return {
		config: {
			database: {
				entrypoint: `test-plugin-publication-cache-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		plugins: [plugin],
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		createScheduler: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

describe("plugin publication route cache invalidation", () => {
	let runtime: EmDashRuntime;
	let contentId: string;

	beforeEach(async () => {
		runtime = await EmDashRuntime.create(createDeps());
		const registry = new SchemaRegistry(runtime.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		const item = await new ContentRepository(runtime.db).create({
			type: "post",
			slug: `cache-${randomUUID()}`,
			status: "draft",
			data: {},
		});
		targetSlug = item.slug;
		contentId = item.id;
	});

	afterEach(async () => {
		await runtime.stopCron();
	});

	async function invoke(path: string) {
		const invalidate = vi.fn().mockResolvedValue(undefined);
		const request = new Request(`http://test.local/_emdash/api/plugins/publication-route/${path}`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		});
		const response = await POST({
			params: { pluginId: "publication-route", path },
			request,
			locals: {
				emdash: runtime,
				user: {
					id: "admin-1",
					email: "admin@example.com",
					name: "Admin",
					role: Role.ADMIN,
					createdAt: new Date("2026-01-01T00:00:00.000Z"),
				},
			},
			cache: { enabled: true, invalidate },
		} as never);
		return { invalidate, response };
	}

	it("invalidates collection and canonical item tags after publication by slug", async () => {
		const { invalidate, response } = await invoke("publish");

		expect(response.status).toBe(200);
		expect(invalidate).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledWith({ tags: ["post", contentId] });
	});

	it("invalidates a committed publication when the plugin route later fails", async () => {
		const { invalidate, response } = await invoke("publish-then-fail");

		expect(response.status).toBe(500);
		expect(invalidate).toHaveBeenCalledOnce();
		expect(invalidate).toHaveBeenCalledWith({ tags: ["post", contentId] });
	});
});
