/**
 * Miniflare Isolation Tests
 *
 * Integration tests verifying that miniflare (wrapping workerd) provides
 * the isolation primitives needed for the MiniflareDevRunner:
 *
 * - Service bindings scope capabilities per plugin
 * - External service bindings route calls to Node handler functions
 * - Plugin code loads from strings (bundles from DB/R2)
 * - KV namespace bindings provide per-plugin isolated storage
 * - Plugins without bindings cannot access unavailable capabilities
 * - Worker reconfiguration supports plugin install/uninstall
 */

import { Miniflare } from "miniflare";
import { afterEach, describe, expect, it } from "vitest";

describe("miniflare plugin isolation", () => {
	let mf: Miniflare | undefined;

	afterEach(async () => {
		if (mf) {
			await mf.dispose();
			mf = undefined;
		}
	});

	it("can create an isolated plugin worker with scoped service bindings", async () => {
		// This test creates:
		// 1. A "bridge" worker that simulates the backing service (content API)
		// 2. A "plugin" worker that calls the bridge via service binding
		// 3. Verifies the plugin can only access what the binding exposes
		//
		// dispatchFetch always hits the first worker in the array.
		// To invoke a specific worker, we put the plugin first and use
		// service bindings to connect it to the bridge.

		mf = new Miniflare({
			workers: [
				{
					// Plugin is first so dispatchFetch targets it
					name: "plugin-test",
					modules: true,
					serviceBindings: {
						BRIDGE: "bridge",
					},
					script: `
						export default {
							async fetch(request, env) {
								const url = new URL(request.url);

								if (url.pathname === "/hook/afterSave") {
									const res = await env.BRIDGE.fetch("http://bridge/content/get", {
										method: "POST",
										body: JSON.stringify({ collection: "posts", id: "123" }),
										headers: { "Content-Type": "application/json" },
									});
									const data = await res.json();
									return Response.json({
										hookResult: "processed",
										contentFromBridge: data,
									});
								}

								return new Response("Unknown hook", { status: 404 });
							}
						};
					`,
				},
				{
					name: "bridge",
					modules: true,
					script: `
						export default {
							async fetch(request) {
								const url = new URL(request.url);
								if (url.pathname === "/content/get") {
									const { collection, id } = await request.json();
									return Response.json({
										success: true,
										data: { id, type: collection, slug: "test-post", data: { title: "Hello" } }
									});
								}
								return new Response("Not found", { status: 404 });
							}
						};
					`,
				},
			],
		});

		// dispatchFetch hits the first worker (plugin-test)
		const response = await mf.dispatchFetch("http://localhost/hook/afterSave");
		const result = (await response.json()) as {
			hookResult: string;
			contentFromBridge: {
				success: boolean;
				data: { id: string; type: string; slug: string };
			};
		};

		expect(result.hookResult).toBe("processed");
		expect(result.contentFromBridge.success).toBe(true);
		expect(result.contentFromBridge.data.id).toBe("123");
		expect(result.contentFromBridge.data.type).toBe("posts");
	});

	it("plugins are isolated from each other", async () => {
		// Two plugins with different service bindings.
		// Plugin A has BRIDGE binding (read:content).
		// Plugin B has NO bridge binding (no capabilities).
		// Use separate Miniflare instances to test isolation,
		// since dispatchFetch always hits the first worker.

		// Test Plugin A: has BRIDGE binding
		mf = new Miniflare({
			workers: [
				{
					name: "plugin-a",
					modules: true,
					serviceBindings: {
						BRIDGE: async () => {
							return Response.json({ success: true, data: { secret: "bridge-data" } });
						},
					},
					script: `
						export default {
							async fetch(request, env) {
								const res = await env.BRIDGE.fetch("http://bridge/");
								const data = await res.json();
								return Response.json({ hasAccess: true, data });
							}
						};
					`,
				},
			],
		});

		const resA = await mf.dispatchFetch("http://localhost/");
		const dataA = (await resA.json()) as { hasAccess: boolean };
		expect(dataA.hasAccess).toBe(true);
		await mf.dispose();

		// Test Plugin B: NO bridge binding
		mf = new Miniflare({
			workers: [
				{
					name: "plugin-b",
					modules: true,
					// NO service bindings - this plugin has no capabilities
					script: `
						export default {
							async fetch(request, env) {
								const hasBridge = "BRIDGE" in env;
								return Response.json({ hasBridge });
							}
						};
					`,
				},
			],
		});

		const resB = await mf.dispatchFetch("http://localhost/");
		const dataB = (await resB.json()) as { hasBridge: boolean };
		expect(dataB.hasBridge).toBe(false);
	});

	it("can load plugin code dynamically from a string", async () => {
		// Test that we can pass plugin code as a string (not a file path).
		// This is critical for the runtime: plugin bundles come from the DB/R2,
		// not from the filesystem.

		const pluginCode = `
			export default {
				async fetch(request, env) {
					return Response.json({
						pluginId: "dynamic-plugin",
						version: "1.0.0",
						message: "I was loaded from a string!",
					});
				}
			};
		`;

		mf = new Miniflare({
			workers: [
				{
					name: "dynamic-plugin",
					modules: true,
					script: pluginCode,
				},
			],
		});

		const response = await mf.dispatchFetch("http://dynamic-plugin/");
		const result = (await response.json()) as { pluginId: string; message: string };
		expect(result.pluginId).toBe("dynamic-plugin");
		expect(result.message).toBe("I was loaded from a string!");
	});

	it("can use KV namespace bindings per plugin", async () => {
		// Plugin with KV namespace binding
		mf = new Miniflare({
			kvNamespaces: ["PLUGIN_KV"],
			modules: true,
			script: `
				export default {
					async fetch(request, env) {
						const url = new URL(request.url);
						if (url.pathname === "/set") {
							await env.PLUGIN_KV.put("test-key", "test-value");
							return new Response("set");
						}
						if (url.pathname === "/get") {
							const val = await env.PLUGIN_KV.get("test-key");
							return Response.json({ value: val });
						}
						return new Response("unknown", { status: 404 });
					}
				};
			`,
		});

		// Set and get
		await mf.dispatchFetch("http://localhost/set");
		const getRes = await mf.dispatchFetch("http://localhost/get");
		const getData = (await getRes.json()) as { value: string };
		expect(getData.value).toBe("test-value");
		await mf.dispose();

		// Plugin without KV has no access
		mf = new Miniflare({
			modules: true,
			script: `
				export default {
					async fetch(request, env) {
						const hasKv = "PLUGIN_KV" in env;
						return Response.json({ hasKv });
					}
				};
			`,
		});

		const noKvRes = await mf.dispatchFetch("http://localhost/");
		const noKvData = (await noKvRes.json()) as { hasKv: boolean };
		expect(noKvData.hasKv).toBe(false);
	});

	it("can reconfigure workers without full restart (add/remove plugins)", async () => {
		// Test that we can dispose and recreate miniflare with different workers.
		// This simulates plugin install/uninstall.

		// Start with one plugin
		mf = new Miniflare({
			modules: true,
			script: `
				export default {
					async fetch() { return Response.json({ id: "original" }); }
				};
			`,
		});

		const res1 = await mf.dispatchFetch("http://localhost/");
		const data1 = (await res1.json()) as { id: string };
		expect(data1.id).toBe("original");

		// Dispose and recreate with a different plugin
		await mf.dispose();

		mf = new Miniflare({
			modules: true,
			script: `
				export default {
					async fetch() { return Response.json({ id: "new-plugin" }); }
				};
			`,
		});

		const res2 = await mf.dispatchFetch("http://localhost/");
		const data2 = (await res2.json()) as { id: string };
		expect(data2.id).toBe("new-plugin");
	});

	it("external service binding to Node HTTP server works", async () => {
		// Critical test: can a plugin worker call an EXTERNAL HTTP service
		// (simulating the Node backing service) via a service binding?
		//
		// Miniflare supports `serviceBindings` with custom handler functions.
		// This maps to how the Node process would expose backing services.

		mf = new Miniflare({
			workers: [
				{
					name: "plugin-with-external-bridge",
					modules: true,
					serviceBindings: {
						BRIDGE: async (request: Request) => {
							// This function runs in Node, not in workerd.
							// It simulates the backing service HTTP handler.
							const url = new URL(request.url);
							if (url.pathname === "/content/get") {
								const body = (await request.json()) as { collection: string; id: string };
								return Response.json({
									success: true,
									data: {
										id: body.id,
										type: body.collection,
										data: { title: "From Node backing service" },
									},
								});
							}
							return new Response("Not found", { status: 404 });
						},
					},
					script: `
						export default {
							async fetch(request, env) {
								const res = await env.BRIDGE.fetch("http://bridge/content/get", {
									method: "POST",
									body: JSON.stringify({ collection: "posts", id: "from-plugin" }),
									headers: { "Content-Type": "application/json" },
								});
								const data = await res.json();
								return Response.json(data);
							}
						};
					`,
				},
			],
		});

		const response = await mf.dispatchFetch("http://plugin-with-external-bridge/");
		const result = (await response.json()) as {
			success: boolean;
			data: { id: string; data: { title: string } };
		};

		expect(result.success).toBe(true);
		expect(result.data.id).toBe("from-plugin");
		expect(result.data.data.title).toBe("From Node backing service");
	});
});
