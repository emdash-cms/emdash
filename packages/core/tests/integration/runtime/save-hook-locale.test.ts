import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { SandboxedPluginInstance } from "../../../src/plugins/sandbox/types.js";
import type { ContentHookEvent } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const deferred: Array<() => void | Promise<void>> = [];

vi.mock("../../../src/after.js", () => ({
	after: (fn: () => void | Promise<void>) => {
		deferred.push(fn);
	},
}));

async function flushDeferred(): Promise<void> {
	const tasks = deferred.splice(0);
	for (const task of tasks) await task();
}

function baseDeps(
	sqlite: Database,
): Pick<RuntimeDependencies, "config" | "createDialect" | "createStorage"> {
	return {
		config: {
			database: {
				entrypoint: `test-save-hook-locale-${randomUUID()}`,
				config: {},
				type: "sqlite",
			},
		},
		createDialect: () => new SqliteDialect({ database: sqlite }),
		createStorage: null,
	};
}

function trustedDeps(
	sqlite: Database,
	before: ContentHookEvent[],
	after: ContentHookEvent[],
): RuntimeDependencies {
	return {
		...baseDeps(sqlite),
		plugins: [
			definePlugin({
				id: "locale-probe",
				version: "1.0.0",
				capabilities: ["content:write", "content:read"],
				hooks: {
					"content:beforeSave": {
						handler: async (event) => {
							before.push(event);
						},
					},
					"content:afterSave": {
						handler: async (event) => {
							after.push(event);
						},
					},
				},
			}),
		],
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

function sandboxedDeps(
	sqlite: Database,
	invokeHook: SandboxedPluginInstance["invokeHook"],
): RuntimeDependencies {
	const runner = {
		isAvailable: () => true,
		isHealthy: () => true,
		load: vi.fn().mockResolvedValue({
			id: "locale-probe:1.0.0",
			invokeHook,
			invokeRoute: vi.fn(),
			terminate: vi.fn(),
		}),
		setEmailSend: vi.fn(),
		terminateAll: vi.fn(),
	};
	return {
		...baseDeps(sqlite),
		plugins: [],
		sandboxEnabled: true,
		sandboxedPluginEntries: [
			{
				id: "locale-probe",
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

async function createPostCollection(runtime: EmDashRuntime): Promise<ContentRepository> {
	const registry = new SchemaRegistry(runtime.db);
	await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
	await registry.createField("post", { slug: "title", label: "Title", type: "string" });
	return new ContentRepository(runtime.db);
}

describe("content save hooks locale", () => {
	let runtime: EmDashRuntime;
	let repo: ContentRepository;

	beforeEach(() => {
		deferred.length = 0;
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
	});

	afterEach(async () => {
		setI18nConfig(null);
		await runtime?.stopCron();
	});

	describe("trusted plugins", () => {
		const before: ContentHookEvent[] = [];
		const after: ContentHookEvent[] = [];

		beforeEach(async () => {
			before.length = 0;
			after.length = 0;
			runtime = await EmDashRuntime.create(trustedDeps(new Database(":memory:"), before, after));
			repo = await createPostCollection(runtime);
		});

		it("passes the default locale when a create names none", async () => {
			const result = await runtime.handleContentCreate("post", { data: { title: "Hi" } });
			expect(result.success).toBe(true);
			await flushDeferred();

			expect(before[0]).toMatchObject({ isNew: true, locale: "en" });
			expect(before[0]?.translationOf).toBeUndefined();
			expect(after[0]).toMatchObject({ isNew: true, locale: "en" });
			expect(after[0]?.translationOf).toBeUndefined();
		});

		it("passes the configured spelling of a requested locale", async () => {
			const result = await runtime.handleContentCreate("post", {
				data: { title: "Bonjour" },
				locale: "FR",
			});
			expect(result.success).toBe(true);

			expect(before[0]?.locale).toBe("fr");
		});

		it("passes the target locale and source id when creating a translation", async () => {
			const source = await runtime.handleContentCreate("post", {
				data: { title: "Hello" },
				locale: "en",
			});
			if (!source.success) throw new Error(source.error.message);
			await flushDeferred();
			before.length = 0;
			after.length = 0;

			const translation = await runtime.handleContentCreate("post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: source.data.item.id,
			});
			expect(translation.success).toBe(true);
			await flushDeferred();

			expect(before[0]).toMatchObject({
				isNew: true,
				locale: "fr",
				translationOf: source.data.item.id,
			});
			expect(after[0]).toMatchObject({
				isNew: true,
				locale: "fr",
				translationOf: source.data.item.id,
			});
		});

		it("passes the stored locale on update, not a locale from the request", async () => {
			const item = await repo.create({ type: "post", data: { title: "Original" }, locale: "fr" });

			const result = await runtime.handleContentUpdate("post", item.id, {
				data: { title: "Changed" },
			});
			expect(result.success).toBe(true);
			await flushDeferred();

			expect(before).toEqual([
				{
					content: { title: "Changed" },
					collection: "post",
					isNew: false,
					id: item.id,
					locale: "fr",
				},
			]);
			expect(after[0]).toMatchObject({ isNew: false, locale: "fr" });
			expect(after[0]?.translationOf).toBeUndefined();
		});
	});

	describe("sandboxed plugins", () => {
		const invokeHook = vi.fn<SandboxedPluginInstance["invokeHook"]>();

		beforeEach(async () => {
			invokeHook.mockReset();
			invokeHook.mockResolvedValue(undefined);
			runtime = await EmDashRuntime.create(sandboxedDeps(new Database(":memory:"), invokeHook));
			repo = await createPostCollection(runtime);
		});

		it("receives the locale and source id of a translation", async () => {
			const source = await repo.create({ type: "post", data: { title: "Hello" }, locale: "en" });

			const result = await runtime.handleContentCreate("post", {
				data: { title: "Bonjour" },
				locale: "fr",
				translationOf: source.id,
			});
			expect(result.success).toBe(true);
			await flushDeferred();

			expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
				content: { title: "Bonjour" },
				collection: "post",
				isNew: true,
				locale: "fr",
				translationOf: source.id,
			});
			expect(invokeHook).toHaveBeenCalledWith(
				"content:afterSave",
				expect.objectContaining({ isNew: true, locale: "fr", translationOf: source.id }),
			);
		});

		it("receives the stored locale on update", async () => {
			const item = await repo.create({ type: "post", data: { title: "Original" }, locale: "fr" });

			const result = await runtime.handleContentUpdate("post", item.id, {
				data: { title: "Changed" },
			});
			expect(result.success).toBe(true);

			expect(invokeHook).toHaveBeenCalledWith("content:beforeSave", {
				content: { title: "Changed" },
				collection: "post",
				isNew: false,
				id: item.id,
				locale: "fr",
			});
		});
	});
});
