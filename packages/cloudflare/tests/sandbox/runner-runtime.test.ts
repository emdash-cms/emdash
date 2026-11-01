import type {
	ContentActionCallbacks,
	PluginCapability,
	SandboxCommentModerateCallback,
	SandboxContentCreateCallback,
	TaxonomyAccessWithWrite,
	SandboxOptions,
} from "emdash";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	loader: { get: vi.fn() },
	bridge: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
	// eslint-disable-next-line typescript/no-extraneous-class -- Cloudflare RPC base class stub
	RpcTarget: class {},
	WorkerEntrypoint: class {
		constructor(
			readonly ctx: unknown,
			readonly env: Record<string, unknown>,
		) {}
	},
	env: { LOADER: mocks.loader },
	exports: { PluginBridge: mocks.bridge },
}));

import { CloudflareSandboxRunner } from "../../src/sandbox/runner.js";

const request = {
	url: "https://example.com/ops",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

function setupLoader(pluginModule: unknown) {
	mocks.loader.get.mockImplementation((_name: string, create: () => any) => {
		const definition = create();
		const source = definition.modules["plugin.js"].js
			.replace('import { WorkerEntrypoint } from "cloudflare:workers";', "")
			.replace('import pluginModule from "sandbox-plugin.js";', "")
			.replace("export default class PluginEntrypoint", "return class PluginEntrypoint");
		// eslint-disable-next-line no-implied-eval -- generated worker module is under test
		const factory = new Function("WorkerEntrypoint", "pluginModule", source);
		const Entrypoint = factory(
			class {
				constructor(
					readonly ctx: unknown,
					readonly env: Record<string, unknown>,
				) {}
			},
			pluginModule,
		);
		return {
			getEntrypoint: () => new Entrypoint(undefined, definition.env),
		};
	});
}

function loopbackBridge() {
	return new Proxy(
		{},
		{
			get: () => () => {
				throw new Error("loopback callback unavailable");
			},
		},
	);
}

function runner(options: Partial<SandboxOptions> = {}) {
	mocks.bridge.mockImplementation(() => loopbackBridge());
	return new CloudflareSandboxRunner({ db: null as never, ...options });
}

const manifest = (capabilities: PluginCapability[]) => ({
	id: "runtime-plugin",
	version: "1.0.0",
	capabilities,
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: ["ops"],
	admin: {},
});

describe("Cloudflare sandbox runner runtime targets", () => {
	it("threads the runner write guard and records only successful creates", async () => {
		const writes: string[] = [];
		let blocked = true;
		setupLoader({
			routes: { ops: async (_route: unknown, ctx: any) => ctx.content.create("posts", {}) },
		});
		const instance = runner({
			beforeContentWrite: async () => {
				if (blocked)
					throw Object.assign(new Error("import blocked"), {
						name: "TRANSFER_IMPORT_IN_PROGRESS",
						code: "TRANSFER_IMPORT_IN_PROGRESS",
						status: 503,
					});
				return async () => {
					writes.push("recorded");
				};
			},
		});
		instance.setContentCreate(async () => {
			writes.push("created");
			return { id: "p" } as never;
		});
		const plugin = await instance.load(manifest(["content:write"]), "");
		await expect(plugin.invokeRoute("ops", {}, request)).rejects.toMatchObject({
			code: "TRANSFER_IMPORT_IN_PROGRESS",
			status: 503,
		});
		expect(writes).toEqual([]);
		blocked = false;
		await plugin.invokeRoute("ops", {}, request);
		expect(writes).toEqual(["created", "recorded"]);
		await instance.terminateAll();
	});

	it("keeps simultaneous runners and hook origins isolated", async () => {
		const created: string[] = [];
		setupLoader({
			hooks: {
				"content:beforeSave": async (_event: unknown, ctx: any) => ctx.content.create("posts", {}),
			},
		});
		const a = runner();
		const b = runner();
		for (const [instance, name] of [
			[a, "a"],
			[b, "b"],
		] as const) {
			instance.setContentCreate(async (_plugin, _collection, _data, options) => {
				if (options?.originHook !== "content:beforeSave") throw new Error("Lost save hook origin");
				created.push(name);
				return { id: name } as never;
			});
		}
		const pluginA = await a.load(manifest(["content:write"]), "");
		const pluginB = await b.load(manifest(["content:write"]), "");
		await Promise.all([
			pluginA.invokeHook("content:beforeSave", {}),
			pluginB.invokeHook("content:beforeSave", {}),
		]);
		await a.terminateAll();
		await pluginB.invokeHook("content:beforeSave", {});
		expect(created.toSorted()).toEqual(["a", "b", "b"]);
		await b.terminateAll();
	});

	it("uses invocation targets for writes even when the loopback bridge is unavailable", async () => {
		const calls: unknown[] = [];
		const contentCreate: SandboxContentCreateCallback = async (...args) => {
			calls.push(["create", ...args]);
			return { id: "source", translationGroup: "group-1" } as never;
		};
		const taxonomyWrite = {
			createTerm: async (...args: unknown[]) => {
				calls.push(["term", ...args]);
				return { id: "term-1" };
			},
		} as unknown as TaxonomyAccessWithWrite;
		const commentModerate: SandboxCommentModerateCallback = async (...args) => {
			calls.push(["comment", ...args]);
			return { id: args[1], status: args[2] } as never;
		};
		setupLoader({
			routes: {
				ops: async (_route: unknown, ctx: any) => ({
					term: await ctx.taxonomies.createTerm("category", { label: "new" }),
					comment: await ctx.comments.setStatus("c-1", "approved", { expectedStatus: "pending" }),
					created: await ctx.content.create(
						"posts",
						{ title: "translated" },
						{ locale: "fr", translationOf: "source" },
					),
				}),
			},
		});
		const instance = runner({ taxonomyWrite, commentModerate });
		await instance.load(manifest(["content:write", "taxonomies:write", "comments:moderate"]), "");
		instance.setContentCreate(contentCreate);
		const plugin = await instance.load(
			manifest(["content:write", "taxonomies:write", "comments:moderate"]),
			"",
		);
		const result = await plugin.invokeRoute("ops", {}, request);
		expect(result).toMatchObject({ term: { id: "term-1" }, comment: { status: "approved" } });
		expect(calls).toEqual([
			["term", "category", { label: "new" }],
			["comment", "runtime-plugin", "c-1", "approved", "pending"],
			[
				"create",
				"runtime-plugin",
				"posts",
				{ title: "translated" },
				{
					locale: "fr",
					translationOf: "source",
					sandboxOrigin: true,
				},
			],
		]);
		await instance.terminateAll();
	});

	it("does not fall back to a database insert and reconstructs content errors", async () => {
		setupLoader({
			routes: { ops: async (_route: unknown, ctx: any) => ctx.content.create("posts", {}, {}) },
		});
		const instance = runner();
		const plugin = await instance.load(manifest(["content:write"]), "");
		await expect(plugin.invokeRoute("ops", {}, request)).rejects.toThrow(
			"Content creation is not configured",
		);
		instance.setContentCreate(async () => {
			throw Object.assign(new Error("rejected"), { code: "SAVE_REJECTED" });
		});
		await expect(plugin.invokeRoute("ops", {}, request)).rejects.toMatchObject({
			name: "SAVE_REJECTED",
			code: "SAVE_REJECTED",
		});
		instance.setContentCreate(async () => {
			throw Object.assign(new Error("already changed"), { code: "CONFLICT" });
		});
		await expect(plugin.invokeRoute("ops", {}, request)).rejects.toMatchObject({
			name: "CONFLICT",
			code: "CONFLICT",
		});
		await instance.terminateAll();
	});

	it("denies a missing taxonomy capability before calling a host callback", async () => {
		setupLoader({
			routes: {
				ops: async (_route: unknown, ctx: any) => ctx.taxonomies.createTerm("category", {}),
			},
		});
		const instance = runner({
			taxonomyWrite: { createTerm: vi.fn() } as unknown as TaxonomyAccessWithWrite,
		});
		const plugin = await instance.load(manifest([]), "");
		await expect(plugin.invokeRoute("ops", {}, request)).rejects.toThrow(
			"Missing capability: taxonomies:write",
		);
		await instance.terminateAll();
	});

	it("keeps publication bookkeeping on the host for concurrent invocation IDs", async () => {
		const begin: string[] = [];
		const flushed: string[] = [];
		const published: string[] = [];
		const invalidators = new Map<string, ((tags: string[]) => Promise<void>) | undefined>();
		const invalidateContentCache = vi.fn(async (_tags: string[]) => {});
		const actions: ContentActionCallbacks = {
			begin: (_plugin, id, invalidate) => {
				begin.push(id);
				invalidators.set(id, invalidate);
			},
			flush: async (_plugin, id) => {
				if (id) flushed.push(id);
			},
			getVersioned: async () => null,
			publish: async (_plugin, _collection, _id, _options, id) => {
				published.push(id!);
				await invalidators.get(id!)?.(["content:posts"]);
				return {} as never;
			},
			unpublish: async () => ({}) as never,
			schedule: async () => ({}) as never,
			unschedule: async () => ({}) as never,
			restore: async () => ({}) as never,
			getTrashedVersioned: async () => null,
		};
		setupLoader({
			routes: {
				ops: async (_route: unknown, ctx: any) => ctx.content.publish("posts", "p", { _rev: "r" }),
			},
		});
		const instance = runner({ contentActions: actions });
		const plugin = await instance.load(manifest(["content:publish"]), "");
		await Promise.all([
			plugin.invokeRoute("ops", {}, request, { invalidateContentCache }),
			plugin.invokeRoute("ops", {}, request, { invalidateContentCache }),
		]);
		expect(new Set(begin).size).toBe(2);
		expect(invalidateContentCache.mock.calls).toEqual([[["content:posts"]], [["content:posts"]]]);
		expect(published).toEqual(expect.arrayContaining(begin));
		expect(flushed).toEqual(expect.arrayContaining(begin));
		await instance.terminateAll();
	});
});
