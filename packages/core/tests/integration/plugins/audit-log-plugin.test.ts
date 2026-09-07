/**
 * Runs the audit-log plugin the way a site that bundles it does: the manifest
 * supplies the trust contract and the sandbox entry supplies the hooks. The
 * hook pipeline drops any hook the declared capabilities do not cover, so
 * these tests fail when the manifest stops matching the entry.
 */

import { readFileSync } from "node:fs";

import { parse as parseJsonc } from "jsonc-parser";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

import auditLog from "../../../../plugins/audit-log/src/plugin.js";
import type { EmDashConfig, PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { adaptSandboxEntry } from "../../../src/plugins/adapt-sandbox-entry.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import { createHookPipeline, type HookPipeline } from "../../../src/plugins/hooks.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

const MANIFEST_URL = new URL("../../../../plugins/audit-log/emdash-plugin.jsonc", import.meta.url);

interface AuditLogManifest {
	slug: string;
	capabilities: string[];
	allowedHosts: string[];
	storage: Record<string, { indexes?: string[]; uniqueIndexes?: string[] }>;
}

interface AuditEntry {
	action: string;
	resourceId: string;
	changes?: { before?: Record<string, unknown>; after?: Record<string, unknown> };
}

function loadAuditLogPlugin(): ResolvedPlugin {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the manifest is validated by the plugin CLI; the test only reads the trust contract
	const manifest = parseJsonc(readFileSync(MANIFEST_URL, "utf8")) as AuditLogManifest;
	const descriptor: PluginDescriptor = {
		id: manifest.slug,
		version: "0.0.0-test",
		entrypoint: "@emdash-cms/plugin-audit-log/sandbox",
		format: "standard",
		capabilities: manifest.capabilities,
		allowedHosts: manifest.allowedHosts,
		storage: manifest.storage,
	};
	return adaptSandboxEntry(auditLog, descriptor);
}

function buildRuntime(
	db: Kysely<Database>,
	plugin: ResolvedPlugin,
	hooks: HookPipeline,
): EmDashRuntime {
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const runtimeDeps = {
		config,
		plugins: [plugin],
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: [],
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: [plugin],
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef: { current: hooks },
	});
}

describe("audit-log plugin", () => {
	let db: Kysely<Database>;
	let plugin: ResolvedPlugin;
	let hooks: HookPipeline;
	let runtime: EmDashRuntime;
	let warn: MockInstance<typeof console.warn>;

	async function readEntries(): Promise<AuditEntry[]> {
		const ctx = new PluginContextFactory({ db }).createContext(plugin);
		const result = await ctx.storage.entries!.query({
			orderBy: { timestamp: "desc" },
			limit: 50,
		});
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- entries are written by the plugin under test
		return result.items.map((item) => item.data as AuditEntry);
	}

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		plugin = loadAuditLogPlugin();
		hooks = createHookPipeline([plugin], { db });
		runtime = buildRuntime(db, plugin, hooks);
	});

	afterEach(async () => {
		warn.mockRestore();
		await teardownTestDatabase(db);
	});

	it("registers every hook the sandbox entry declares", () => {
		const registered = hooks.getRegisteredHooks();
		for (const name of Object.keys(auditLog.hooks)) {
			expect(registered, `${name} should be registered`).toContain(name);
		}
		expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("skipping"));
	});

	it("records the previous state when content is updated", async () => {
		const created = await runtime.handleContentCreate("post", {
			data: { title: "Before" },
			slug: "audited-post",
			status: "draft",
		});
		if (!created.success) throw new Error("create failed");
		await waitForDeferredTasks();

		const updated = await runtime.handleContentUpdate("post", created.data.item.id, {
			data: { title: "After" },
		});
		expect(updated.success).toBe(true);
		await waitForDeferredTasks();

		const entry = (await readEntries()).find((e) => e.action === "update");
		expect(entry).toBeDefined();
		expect(entry?.resourceId).toBe(created.data.item.id);
		expect(entry?.changes?.before).toEqual({ title: "Before" });
		expect(entry?.changes?.after).toEqual({ title: "After" });
	});

	it("records media uploads", async () => {
		await hooks.runMediaAfterUpload({
			id: "media-1",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			size: 1234,
			url: "/media/media-1/photo.jpg",
			createdAt: new Date().toISOString(),
		});

		expect(await readEntries()).toContainEqual(
			expect.objectContaining({ action: "media:upload", resourceId: "media-1" }),
		);
	});
});
