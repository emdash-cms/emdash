import type {
	ContentActionCallbacks,
	PluginCapability,
	SandboxCommentModerateCallback,
	SandboxContentCreateCallback,
	TaxonomyAccessWithWrite,
	SandboxOptions,
} from "emdash";
import { describe, expect, it, vi } from "vitest";

import atprotoPlugin from "../../../plugins/atproto/src/plugin.js";

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
		const bridge = definition.env.BRIDGE;
		const budget = definition.limits?.subRequests;
		if (budget !== undefined) {
			let calls = 0;
			definition.env.BRIDGE = new Proxy(bridge, {
				get(target, property, receiver) {
					const value = Reflect.get(target, property, receiver);
					if (typeof value !== "function") return value;
					return (...args: unknown[]) => {
						calls += 1;
						if (calls > budget)
							return Promise.reject(new Error(`Subrequest limit exceeded: ${budget}`));
						return value(...args);
					};
				},
			});
		}
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

function atprotoBridge() {
	const kv = new Map<string, unknown>();
	let nextRkey = 1;
	let publicationCreates = 0;
	const response = (status: number, body: unknown) => ({
		status,
		statusText: status === 200 ? "OK" : "Bad Request",
		headers: [["content-type", "application/json"]] as Array<[string, string]>,
		finalUrl: "https://pds.example",
		redirected: false,
		body: new TextEncoder().encode(JSON.stringify(body)),
	});
	const bridge = {
		kvGet: async (key: string) => kv.get(key) ?? null,
		kvSet: async (key: string, value: unknown) => {
			kv.set(key, value);
			return true;
		},
		storageCount: async () => 0,
		storageQuery: async () => ({ items: [], total: 0 }),
		log: async () => {},
		httpFetch: async (url: string, init?: RequestInit) => {
			const method = url.split("/xrpc/")[1];
			if (method === "com.atproto.server.createSession")
				return response(200, {
					accessJwt: "access-token",
					refreshJwt: "refresh-token",
					did: "did:plc:test",
					handle: "test.example",
				});
			if (method === "com.atproto.repo.createRecord") {
				const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
				const rkey = String(nextRkey++);
				const uri = `at://did:plc:test/${body.collection}/${rkey}`;
				if (body.collection === "site.standard.publication") publicationCreates += 1;
				return response(200, { uri, cid: `cid-${rkey}` });
			}
			if (method === "com.atproto.repo.putRecord") {
				const body = JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
				return response(200, {
					uri: `at://did:plc:test/${body.collection}/${body.rkey}`,
					cid: "cid-updated",
				});
			}
			throw new Error(`Unexpected PDS request: ${url}`);
		},
	};
	return { bridge, kv, publicationCreates: () => publicationCreates };
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

	it("persists an AT Protocol publication across sync invocations", async () => {
		const pds = atprotoBridge();
		mocks.bridge.mockImplementation(() => pds.bridge);
		setupLoader(atprotoPlugin);
		const instance = new CloudflareSandboxRunner({
			db: null as never,
			httpFetch: async () => new Response(),
		});
		const plugin = await instance.load(
			{
				id: "atproto",
				version: "0.2.4",
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				storage: { records: { indexes: [] } },
				hooks: [],
				routes: ["admin", "sync-publication", "status"],
				admin: {},
			},
			"",
		);
		const settings = {
			type: "form_submit",
			action_id: "save_settings",
			values: {
				handle: "test.example",
				appPassword: "app-password",
				pdsHost: "pds.example",
				siteUrl: "https://example.com",
				siteName: "Example",
			},
		};
		const saved = await plugin.invokeRoute("admin", settings, request);
		expect(saved).toMatchObject({ toast: { type: "success" } });
		expect(saved).not.toMatchObject({
			blocks: [{ title: "Failed to load settings" }],
		});
		const first = await plugin.invokeRoute(
			"admin",
			{
				type: "block_action",
				action_id: "sync_publication",
			},
			request,
		);
		expect(first).toMatchObject({ toast: { type: "success" } });
		expect(first).not.toMatchObject({ blocks: [{ title: "Failed to load settings" }] });
		const firstUri = pds.kv.get("state:publicationUri");
		expect(firstUri).toEqual(expect.any(String));
		const second = await plugin.invokeRoute("sync-publication", {}, request);
		const status = await plugin.invokeRoute("status", {}, request);
		expect(second).toMatchObject({ success: true, uri: firstUri, cid: "cid-updated" });
		expect(status).toMatchObject({ publicationUri: firstUri, connected: true });
		expect(pds.publicationCreates()).toBe(1);
		expect(pds.kv.get("state:publicationUri")).toBe(firstUri);
		expect(pds.kv.get("state:publicationCid")).toBe("cid-updated");
		const reloaded = await plugin.invokeRoute("admin", {}, request);
		expect(reloaded).not.toMatchObject({
			blocks: [{ title: "Failed to load settings" }],
		});
		await instance.terminateAll();
	});

	it("preserves an explicit lower subrequest limit", async () => {
		const pds = atprotoBridge();
		mocks.bridge.mockImplementation(() => pds.bridge);
		setupLoader(atprotoPlugin);
		const instance = new CloudflareSandboxRunner({
			db: null as never,
			httpFetch: async () => new Response(),
			limits: { subrequests: 10 },
		});
		const plugin = await instance.load(
			{
				id: "atproto-limited",
				version: "0.2.4",
				capabilities: ["network:request:unrestricted"],
				allowedHosts: [],
				storage: { records: { indexes: [] } },
				hooks: [],
				routes: ["admin", "sync-publication"],
				admin: {},
			},
			"",
		);
		for (const [key, value] of Object.entries({
			"settings:siteUrl": "https://example.com",
			"settings:siteName": "Example",
			"settings:handle": "test.example",
			"settings:appPassword": "app-password",
			"state:accessJwt": "access-token",
			"state:did": "did:plc:test",
		}))
			pds.kv.set(key, value);
		const result = await plugin.invokeRoute("sync-publication", {}, request);
		expect(result).toMatchObject({ success: false, error: "Subrequest limit exceeded: 10" });
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
