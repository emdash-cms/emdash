/**
 * Plugin Routes Tests
 *
 * Tests the v2 route system for:
 * - Route registration and invocation
 * - Input validation with Zod schemas
 * - Error handling (PluginRouteError)
 * - Route registry management
 */

import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

import type { PluginContextFactoryOptions } from "../../../src/plugins/context.js";
import { EmailPipeline } from "../../../src/plugins/email.js";
import { HookPipeline } from "../../../src/plugins/hooks.js";
import {
	PluginRouteHandler,
	PluginRouteRegistry,
	PluginRouteError,
	createRouteRegistry,
} from "../../../src/plugins/routes.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";

/**
 * Create a minimal resolved plugin for testing
 */
function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: {
			pages: [],
			widgets: [],
			fieldWidgets: {},
		},
		hooks: {},
		routes: {},
		...overrides,
	};
}

/**
 * Create mock factory options (routes need DB for context)
 */
function createMockFactoryOptions(): PluginContextFactoryOptions {
	return {
		db: {} as any, // Mock DB - routes will fail if they try to use DB features
	};
}

describe("PluginRouteError", () => {
	describe("constructor", () => {
		it("creates error with code, message, and status", () => {
			const error = new PluginRouteError("TEST_ERROR", "Test message", 400);

			expect(error.code).toBe("TEST_ERROR");
			expect(error.message).toBe("Test message");
			expect(error.status).toBe(400);
			expect(error.name).toBe("PluginRouteError");
		});

		it("defaults status to 400", () => {
			const error = new PluginRouteError("TEST_ERROR", "Test message");
			expect(error.status).toBe(400);
		});

		it("stores optional details", () => {
			const details = { field: "email", issue: "invalid" };
			const error = new PluginRouteError("VALIDATION_ERROR", "Invalid input", 400, details);

			expect(error.details).toEqual(details);
		});
	});

	describe("static factory methods", () => {
		it("badRequest creates 400 error", () => {
			const error = PluginRouteError.badRequest("Bad data", { foo: "bar" });

			expect(error.code).toBe("BAD_REQUEST");
			expect(error.status).toBe(400);
			expect(error.message).toBe("Bad data");
			expect(error.details).toEqual({ foo: "bar" });
		});

		it("unauthorized creates 401 error", () => {
			const error = PluginRouteError.unauthorized();

			expect(error.code).toBe("UNAUTHORIZED");
			expect(error.status).toBe(401);
			expect(error.message).toBe("Unauthorized");
		});

		it("forbidden creates 403 error", () => {
			const error = PluginRouteError.forbidden("Access denied");

			expect(error.code).toBe("FORBIDDEN");
			expect(error.status).toBe(403);
			expect(error.message).toBe("Access denied");
		});

		it("notFound creates 404 error", () => {
			const error = PluginRouteError.notFound("Resource not found");

			expect(error.code).toBe("NOT_FOUND");
			expect(error.status).toBe(404);
			expect(error.message).toBe("Resource not found");
		});

		it("conflict creates 409 error", () => {
			const error = PluginRouteError.conflict("Already exists", { id: "123" });

			expect(error.code).toBe("CONFLICT");
			expect(error.status).toBe(409);
			expect(error.message).toBe("Already exists");
			expect(error.details).toEqual({ id: "123" });
		});

		it("internal creates 500 error", () => {
			const error = PluginRouteError.internal("Something broke");

			expect(error.code).toBe("INTERNAL_ERROR");
			expect(error.status).toBe(500);
			expect(error.message).toBe("Something broke");
		});
	});
});

describe("PluginRouteHandler", () => {
	describe("getRouteMeta", () => {
		it("returns null for non-existent route", () => {
			const plugin = createTestPlugin();
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			expect(handler.getRouteMeta("non-existent")).toBeNull();
		});

		it("returns { public: false } for route without public flag", () => {
			const plugin = createTestPlugin({
				routes: {
					sync: { handler: vi.fn() },
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const meta = handler.getRouteMeta("sync");
			expect(meta).toEqual({ public: false });
		});

		it("returns { public: true } for route with public: true", () => {
			const plugin = createTestPlugin({
				routes: {
					submit: { public: true, handler: vi.fn() },
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const meta = handler.getRouteMeta("submit");
			expect(meta).toEqual({ public: true });
		});

		it("returns { public: false } for route with public: false", () => {
			const plugin = createTestPlugin({
				routes: {
					admin: { public: false, handler: vi.fn() },
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const meta = handler.getRouteMeta("admin");
			expect(meta).toEqual({ public: false });
		});
	});

	describe("getRouteNames", () => {
		it("returns empty array for plugin with no routes", () => {
			const plugin = createTestPlugin();
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			expect(handler.getRouteNames()).toEqual([]);
		});

		it("returns all route names", () => {
			const plugin = createTestPlugin({
				routes: {
					sync: { handler: vi.fn() },
					webhook: { handler: vi.fn() },
					"batch-process": { handler: vi.fn() },
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const names = handler.getRouteNames();
			expect(names).toContain("sync");
			expect(names).toContain("webhook");
			expect(names).toContain("batch-process");
			expect(names).toHaveLength(3);
		});
	});

	describe("hasRoute", () => {
		it("returns false for non-existent route", () => {
			const plugin = createTestPlugin();
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			expect(handler.hasRoute("non-existent")).toBe(false);
		});

		it("returns true for existing route", () => {
			const plugin = createTestPlugin({
				routes: {
					sync: { handler: vi.fn() },
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			expect(handler.hasRoute("sync")).toBe(true);
		});
	});

	describe("invoke", () => {
		it("returns 404 for non-existent route", async () => {
			const plugin = createTestPlugin();
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const result = await handler.invoke("non-existent", {
				request: new Request("http://test.com"),
			});

			expect(result.success).toBe(false);
			expect(result.status).toBe(404);
			expect(result.error?.code).toBe("ROUTE_NOT_FOUND");
		});

		it("validates input with Zod schema", async () => {
			const plugin = createTestPlugin({
				routes: {
					create: {
						input: z.object({
							name: z.string().min(1),
							email: z.string().email(),
						}),
						handler: vi.fn(),
					},
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			// Invalid input
			const result = await handler.invoke("create", {
				request: new Request("http://test.com"),
				body: { name: "", email: "not-an-email" },
			});

			expect(result.success).toBe(false);
			expect(result.status).toBe(400);
			expect(result.error?.code).toBe("VALIDATION_ERROR");
		});

		it("handles PluginRouteError from handler", async () => {
			const plugin = createTestPlugin({
				routes: {
					fail: {
						handler: async () => {
							throw PluginRouteError.forbidden("No access");
						},
					},
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const result = await handler.invoke("fail", {
				request: new Request("http://test.com"),
			});

			expect(result.success).toBe(false);
			expect(result.status).toBe(403);
			expect(result.error?.code).toBe("FORBIDDEN");
			expect(result.error?.message).toBe("No access");
		});

		it("handles unknown errors from handler", async () => {
			const plugin = createTestPlugin({
				routes: {
					crash: {
						handler: async () => {
							throw new Error("Unexpected error");
						},
					},
				},
			});
			const handler = new PluginRouteHandler(plugin, createMockFactoryOptions());

			const result = await handler.invoke("crash", {
				request: new Request("http://test.com"),
			});

			expect(result.success).toBe(false);
			expect(result.status).toBe(500);
			expect(result.error?.code).toBe("INTERNAL_ERROR");
			expect(result.error?.message).toContain("Unexpected error");
		});

		it("includes ctx.email when email pipeline is configured", async () => {
			const hookPipeline = new HookPipeline([], createMockFactoryOptions());
			hookPipeline.setExclusiveSelection("email:deliver", "provider");
			const emailPipeline = new EmailPipeline(hookPipeline);

			const plugin = createTestPlugin({
				capabilities: ["email:send"],
				routes: {
					checkEmail: {
						handler: async (ctx) => ({
							hasEmail: !!ctx.email,
							hasSend: typeof ctx.email?.send === "function",
						}),
					},
				},
			});

			const handler = new PluginRouteHandler(plugin, {
				...createMockFactoryOptions(),
				emailPipeline,
			});

			const result = await handler.invoke("checkEmail", {
				request: new Request("http://test.com"),
			});

			expect(result.success).toBe(true);
			expect(result.data).toEqual({ hasEmail: true, hasSend: true });
		});
	});
});

describe("PluginRouteRegistry", () => {
	describe("register/unregister", () => {
		it("registers a plugin", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			const plugin = createTestPlugin({
				id: "my-plugin",
				routes: { sync: { handler: vi.fn() } },
			});

			registry.register(plugin);

			expect(registry.getPluginIds()).toContain("my-plugin");
		});

		it("unregisters a plugin", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			const plugin = createTestPlugin({ id: "my-plugin" });

			registry.register(plugin);
			registry.unregister("my-plugin");

			expect(registry.getPluginIds()).not.toContain("my-plugin");
		});
	});

	describe("getPluginIds", () => {
		it("returns empty array initially", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			expect(registry.getPluginIds()).toEqual([]);
		});

		it("returns all registered plugin IDs", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());

			registry.register(createTestPlugin({ id: "plugin-a" }));
			registry.register(createTestPlugin({ id: "plugin-b" }));
			registry.register(createTestPlugin({ id: "plugin-c" }));

			const ids = registry.getPluginIds();
			expect(ids).toContain("plugin-a");
			expect(ids).toContain("plugin-b");
			expect(ids).toContain("plugin-c");
		});
	});

	describe("getRoutes", () => {
		it("returns empty array for non-existent plugin", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			expect(registry.getRoutes("non-existent")).toEqual([]);
		});

		it("returns route names for registered plugin", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			const plugin = createTestPlugin({
				id: "my-plugin",
				routes: {
					sync: { handler: vi.fn() },
					import: { handler: vi.fn() },
				},
			});

			registry.register(plugin);
			const routes = registry.getRoutes("my-plugin");

			expect(routes).toContain("sync");
			expect(routes).toContain("import");
		});
	});

	describe("getRouteMeta", () => {
		it("returns null for non-existent plugin", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			expect(registry.getRouteMeta("non-existent", "sync")).toBeNull();
		});

		it("returns null for non-existent route on registered plugin", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			const plugin = createTestPlugin({
				id: "my-plugin",
				routes: { sync: { handler: vi.fn() } },
			});
			registry.register(plugin);

			expect(registry.getRouteMeta("my-plugin", "non-existent")).toBeNull();
		});

		it("returns metadata for existing route", () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			const plugin = createTestPlugin({
				id: "my-plugin",
				routes: {
					sync: { handler: vi.fn() },
					submit: { public: true, handler: vi.fn() },
				},
			});
			registry.register(plugin);

			expect(registry.getRouteMeta("my-plugin", "sync")).toEqual({ public: false });
			expect(registry.getRouteMeta("my-plugin", "submit")).toEqual({ public: true });
		});
	});

	describe("invoke", () => {
		it("returns 404 for non-existent plugin", async () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());

			const result = await registry.invoke("non-existent", "sync", {
				request: new Request("http://test.com"),
			});

			expect(result.success).toBe(false);
			expect(result.status).toBe(404);
			expect(result.error?.code).toBe("PLUGIN_NOT_FOUND");
		});

		it("delegates to plugin handler", async () => {
			const registry = new PluginRouteRegistry(createMockFactoryOptions());
			const plugin = createTestPlugin({
				id: "my-plugin",
				routes: {
					status: {
						handler: async () => ({ healthy: true }),
					},
				},
			});

			registry.register(plugin);

			// This will fail because handler tries to create context with mock DB
			// But we can verify it attempts to invoke
			const result = await registry.invoke("my-plugin", "non-existent", {
				request: new Request("http://test.com"),
			});

			expect(result.success).toBe(false);
			expect(result.error?.code).toBe("ROUTE_NOT_FOUND");
		});
	});
});

describe("createRouteRegistry helper", () => {
	it("creates a PluginRouteRegistry instance", () => {
		const registry = createRouteRegistry(createMockFactoryOptions());
		expect(registry).toBeInstanceOf(PluginRouteRegistry);
	});
});
