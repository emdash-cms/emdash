import { AsyncLocalStorage } from "node:async_hooks";

import { env, exports as workerExports } from "cloudflare:workers";
import { Kysely } from "kysely";
import { describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { PluginRuntimeBridge } from "../../../cloudflare/src/sandbox/runtime-bridge.js";
import { generatePluginWrapper } from "../../../cloudflare/src/sandbox/wrapper.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import type { SandboxOptions } from "../../src/index.js";
import { assertSiteWriteAllowed } from "../../src/transfer/fence.js";
import { TransferOperationRepository } from "../../src/transfer/ops/operations.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
		LOADER: WorkerLoader;
	}
}

const requestScope = new AsyncLocalStorage<string>();

const PLUGIN = `
export default {
  routes: {
    createOnly: async ({ input }, ctx) => {
      try { return await ctx.content.create("posts", { title: input.title }); }
      catch (error) {
        if (error.code === "SAVE_REJECTED") return { error: { code: error.code, message: error.message } };
        throw error;
      }
    },
    all: async ({ input }, ctx) => ({
      versioned: await ctx.content.getVersioned("posts", "source"),
      create: await ctx.content.create("posts", { title: input.title }, { translationOf: "source", locale: "fr" }),
      term: await ctx.taxonomies.createTerm("category", { label: input.title }),
      comment: await ctx.comments.setStatus("comment", "approved", { expectedStatus: "pending" }),
    }),
  },
};
`;

function loadPlugin() {
	const wrapper = generatePluginWrapper(
		{
			id: "rpc-plugin",
			version: "1.0.0",
			capabilities: [
				"content:read",
				"content:write",
				"content:publish",
				"taxonomies:write",
				"comments:moderate",
			],
		} as never,
		{ site: { name: "Test", url: "https://example.test", locale: "en" } },
	);
	const stub = env.LOADER.load({
		compatibilityDate: "2026-05-14",
		compatibilityFlags: ["nodejs_compat"],
		mainModule: "wrapper.js",
		modules: {
			"wrapper.js": wrapper,
			"sandbox-plugin.js": PLUGIN,
		},
		env: {
			BRIDGE: workerExports.PluginBridge({
				props: {
					pluginId: "rpc-plugin",
					pluginVersion: "1.0.0",
					capabilities: [
						"content:write",
						"content:publish",
						"taxonomies:write",
						"comments:moderate",
					],
					allowedHosts: [],
					storageCollections: [],
					contentCreateRuntimeId: "other-isolate-create",
					contentActionsRuntimeId: "other-isolate-actions",
					taxonomyWriteRuntimeId: "other-isolate-taxonomy",
				},
			}),
			PLUGIN_ID: "rpc-plugin",
			PLUGIN_VERSION: "1.0.0",
		},
	});
	return stub.getEntrypoint() as unknown as {
		invokeRoute(
			name: string,
			input: unknown,
			request: unknown,
			invocationId: string,
			runtimeBridge: PluginRuntimeBridge,
		): Promise<unknown>;
	};
}

function runtimeBridge(
	invocationId: string,
	calls: string[],
	beforeContentWrite?: SandboxOptions["beforeContentWrite"],
) {
	const callbacks = {
		i18nConfig: { defaultLocale: "en", locales: ["en", "fr"] },
		beforeContentWrite,
		contentCreate: async (
			_pluginId: string,
			_collection: string,
			_data: Record<string, unknown>,
			options: { translationOf?: string; locale?: string },
		) => {
			expect(requestScope.getStore()).toBe(invocationId);
			calls.push(`${invocationId}:create:${options?.translationOf}:${options?.locale}`);
			if (_data.title === "rejected") {
				throw Object.assign(new Error("save rejected"), { code: "SAVE_REJECTED" });
			}
			return { id: "translated", translationGroup: "group-source", locale: "fr" };
		},
		contentActions: {
			getVersioned: async () => {
				calls.push(`${invocationId}:versioned`);
				return { id: "source", version: 2 };
			},
		} as never,
		taxonomyWrite: {
			createTerm: async () => {
				calls.push(`${invocationId}:taxonomy`);
				return { id: "term", label: "term" };
			},
		} as never,
		commentModerate: async () => {
			calls.push(`${invocationId}:comment`);
			return { id: "comment", status: "approved" };
		},
	};
	return new PluginRuntimeBridge(
		"rpc-plugin",
		["content:write", "content:publish", "taxonomies:write", "comments:moderate"],
		invocationId,
		callbacks,
	);
}

describe("sandbox runtime bridge RPC", () => {
	it("forwards callback operations through the RPC invocation parameter", async () => {
		const plugin = loadPlugin();
		const first: string[] = [];
		const second: string[] = [];

		const [one, two] = await Promise.all([
			requestScope.run("one", () =>
				plugin.invokeRoute(
					"all",
					{ title: "one" },
					{ method: "POST", meta: {} },
					"one",
					runtimeBridge("one", first),
				),
			),
			requestScope.run("two", () =>
				plugin.invokeRoute(
					"all",
					{ title: "two" },
					{ method: "POST", meta: {} },
					"two",
					runtimeBridge("two", second),
				),
			),
		]);

		expect(one).toMatchObject({
			create: { translationGroup: "group-source" },
			versioned: { version: 2 },
		});
		expect(two).toMatchObject({
			create: { translationGroup: "group-source" },
			versioned: { version: 2 },
		});
		expect(first).toEqual(["one:versioned", "one:create:source:fr", "one:taxonomy", "one:comment"]);
		expect(second).toEqual([
			"two:versioned",
			"two:create:source:fr",
			"two:taxonomy",
			"two:comment",
		]);
	});

	it("applies the D1 site-write fence around sandbox content creation", async () => {
		const db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
		await resetD1Schema(db);
		await runMigrations(db);
		const plugin = loadPlugin();
		const calls: string[] = [];
		const operations = new TransferOperationRepository(db);

		const { operation: importOperation } = await operations.create({
			kind: "import",
			createdBy: "test",
		});
		await db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "running" })
			.where("id", "=", importOperation.id)
			.execute();

		const blocked = await requestScope.run("blocked", () =>
			plugin.invokeRoute(
				"createOnly",
				{ title: "blocked" },
				{ method: "POST", meta: {} },
				"blocked",
				runtimeBridge("blocked", calls, async () => {
					calls.push("guard");
					return assertSiteWriteAllowed(db);
				}),
			),
		);
		expect(blocked).toMatchObject({
			__emdashSandboxRouteError: true,
			error: {
				code: "TRANSFER_IMPORT_IN_PROGRESS",
				status: 503,
			},
		});
		expect(calls).toEqual(["guard"]);

		await db
			.deleteFrom("_emdash_transfer_operations")
			.where("id", "=", importOperation.id)
			.execute();
		await db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "activating" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		const mediaBlocked = await requestScope.run("media-blocked", () =>
			plugin.invokeRoute(
				"createOnly",
				{ title: "blocked" },
				{ method: "POST", meta: {} },
				"media-blocked",
				runtimeBridge("media-blocked", calls, () => assertSiteWriteAllowed(db)),
			),
		);
		expect(mediaBlocked).toMatchObject({
			__emdashSandboxRouteError: true,
			error: { code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS", status: 503 },
		});
		expect(calls).toEqual(["guard"]);
		await db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "expanded" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		const { operation: exportOperation } = await operations.create({
			kind: "export",
			createdBy: "test",
		});
		await db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "running", write_epoch: 0 })
			.where("id", "=", exportOperation.id)
			.execute();

		const exported = await requestScope.run("exported", () =>
			plugin.invokeRoute(
				"createOnly",
				{ title: "exported" },
				{ method: "POST", meta: {} },
				"exported",
				runtimeBridge("exported", calls, () => assertSiteWriteAllowed(db)),
			),
		);
		expect(exported).toMatchObject({ id: "translated" });
		await expect(
			db
				.selectFrom("_emdash_transfer_operations")
				.select("write_epoch")
				.where("id", "=", exportOperation.id)
				.executeTakeFirstOrThrow(),
		).resolves.toMatchObject({ write_epoch: 1 });

		await db
			.updateTable("_emdash_transfer_operations")
			.set({ write_epoch: 0 })
			.where("id", "=", exportOperation.id)
			.execute();
		const rejected = await requestScope.run("rejected", () =>
			plugin.invokeRoute(
				"createOnly",
				{ title: "rejected" },
				{ method: "POST", meta: {} },
				"rejected",
				runtimeBridge("rejected", calls, () => assertSiteWriteAllowed(db)),
			),
		);
		expect(rejected).toMatchObject({ error: { code: "SAVE_REJECTED", message: "save rejected" } });
		expect(
			await db
				.selectFrom("_emdash_transfer_operations")
				.select("write_epoch")
				.where("id", "=", exportOperation.id)
				.executeTakeFirstOrThrow(),
		).toMatchObject({ write_epoch: 0 });
		await db.destroy();
	});
});
