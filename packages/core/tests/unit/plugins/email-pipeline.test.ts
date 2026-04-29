/**
 * Email Pipeline Tests
 *
 * Tests the email pipeline:
 * - EmailPipeline.send(): beforeSend transforms, cancellation, deliver dispatch, afterSend
 * - EmailPipeline.isAvailable(): provider selection checks
 * - HookPipeline email hook dispatch: beforeSend chaining, afterSend fire-and-forget
 * - Exclusive hook dispatch for email:deliver
 * - ctx.email gated by email:send capability
 * - Dev console provider captures emails
 */

import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as DbSchema } from "../../../src/database/types.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import {
	clearDevEmails,
	DEV_CONSOLE_EMAIL_PLUGIN_ID,
	devConsoleEmailDeliver,
	getDevEmails,
} from "../../../src/plugins/email-console.js";
import {
	EmailNotConfiguredError,
	EmailPipeline,
	EmailRecursionError,
} from "../../../src/plugins/email.js";
import { HookPipeline } from "../../../src/plugins/hooks.js";
import { PluginManager } from "../../../src/plugins/manager.js";
import type {
	EmailAfterSendHandler,
	EmailBeforeSendEvent,
	EmailBeforeSendHandler,
	EmailDeliverHandler,
	EmailMessage,
	PluginContext,
	ResolvedHook,
	ResolvedPlugin,
} from "../../../src/plugins/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestPlugin(overrides: Partial<ResolvedPlugin> = {}): ResolvedPlugin {
	return {
		id: overrides.id ?? "test-plugin",
		version: "1.0.0",
		capabilities: [],
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [] },
		hooks: {},
		routes: {},
		...overrides,
	};
}

function createTestHook<T>(
	pluginId: string,
	handler: T,
	overrides: Partial<ResolvedHook<T>> = {},
): ResolvedHook<T> {
	return {
		pluginId,
		handler,
		priority: 100,
		timeout: 5000,
		dependencies: [],
		errorPolicy: "continue",
		exclusive: false,
		...overrides,
	};
}

function createTestMessage(overrides: Partial<EmailMessage> = {}): EmailMessage {
	return {
		to: "user@example.com",
		subject: "Test Subject",
		text: "Test body",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// HookPipeline — email:beforeSend
// ---------------------------------------------------------------------------

describe("HookPipeline — email:beforeSend", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("runs email:beforeSend hooks in priority order", async () => {
		const order: string[] = [];

		const handler1: EmailBeforeSendHandler = async (event) => {
			order.push("first");
			return event.message;
		};
		const handler2: EmailBeforeSendHandler = async (event) => {
			order.push("second");
			return event.message;
		};

		const plugin1 = createTestPlugin({
			id: "plugin-first",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("plugin-first", handler1, { priority: 50 }),
			},
		});
		const plugin2 = createTestPlugin({
			id: "plugin-second",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("plugin-second", handler2, { priority: 150 }),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2], { db });
		const message = createTestMessage();

		await pipeline.runEmailBeforeSend(message, "test");

		expect(order).toEqual(["first", "second"]);
	});

	it("chains message transformations", async () => {
		const handler1: EmailBeforeSendHandler = async (event) => {
			return { ...event.message, subject: event.message.subject + " [Modified]" };
		};
		const handler2: EmailBeforeSendHandler = async (event) => {
			return { ...event.message, text: event.message.text + " [Footer]" };
		};

		const plugin1 = createTestPlugin({
			id: "modifier-1",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("modifier-1", handler1, { priority: 50 }),
			},
		});
		const plugin2 = createTestPlugin({
			id: "modifier-2",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("modifier-2", handler2, { priority: 150 }),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2], { db });
		const message = createTestMessage({ subject: "Hello", text: "Body" });

		const result = await pipeline.runEmailBeforeSend(message, "test");

		expect(result.message).not.toBe(false);
		if (result.message !== false) {
			expect(result.message.subject).toBe("Hello [Modified]");
			expect(result.message.text).toBe("Body [Footer]");
		}
	});

	it("cancels delivery when handler returns false", async () => {
		const handler1: EmailBeforeSendHandler = async () => false;
		const handler2 = vi.fn() as unknown as EmailBeforeSendHandler;

		const plugin1 = createTestPlugin({
			id: "canceller",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("canceller", handler1, { priority: 50 }),
			},
		});
		const plugin2 = createTestPlugin({
			id: "after-cancel",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("after-cancel", handler2, { priority: 150 }),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2], { db });
		const result = await pipeline.runEmailBeforeSend(createTestMessage(), "test");

		expect(result.message).toBe(false);
		// Second handler should NOT have been called
		expect(handler2).not.toHaveBeenCalled();
	});

	it("passes source through to event", async () => {
		let receivedSource: string | undefined;
		const handler: EmailBeforeSendHandler = async (event) => {
			receivedSource = event.source;
			return event.message;
		};

		const plugin = createTestPlugin({
			id: "source-checker",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("source-checker", handler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		await pipeline.runEmailBeforeSend(createTestMessage(), "my-plugin");

		expect(receivedSource).toBe("my-plugin");
	});
});

// ---------------------------------------------------------------------------
// HookPipeline — email:afterSend
// ---------------------------------------------------------------------------

describe("HookPipeline — email:afterSend", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("runs afterSend hooks for all plugins", async () => {
		const received: string[] = [];

		const handler1: EmailAfterSendHandler = async () => {
			received.push("a");
		};
		const handler2: EmailAfterSendHandler = async () => {
			received.push("b");
		};

		const plugin1 = createTestPlugin({
			id: "logger-a",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("logger-a", handler1),
			},
		});
		const plugin2 = createTestPlugin({
			id: "logger-b",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("logger-b", handler2),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2], { db });
		const results = await pipeline.runEmailAfterSend(createTestMessage(), "system");

		expect(received).toEqual(["a", "b"]);
		expect(results).toHaveLength(2);
		expect(results.every((r) => r.success)).toBe(true);
	});

	it("catches afterSend errors without propagating", async () => {
		const errorHandler: EmailAfterSendHandler = async () => {
			throw new Error("afterSend crashed");
		};
		const successHandler = vi.fn() as unknown as EmailAfterSendHandler;

		const plugin1 = createTestPlugin({
			id: "broken-logger",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("broken-logger", errorHandler, { priority: 50 }),
			},
		});
		const plugin2 = createTestPlugin({
			id: "good-logger",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("good-logger", successHandler, { priority: 150 }),
			},
		});

		const pipeline = new HookPipeline([plugin1, plugin2], { db });

		// Should NOT throw
		const results = await pipeline.runEmailAfterSend(createTestMessage(), "system");

		expect(results).toHaveLength(2);
		expect(results[0]!.success).toBe(false);
		expect(results[0]!.error?.message).toBe("afterSend crashed");
		// Second handler should still run
		expect(successHandler).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// EmailPipeline
// ---------------------------------------------------------------------------

describe("EmailPipeline", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("isAvailable returns false when no provider is selected", () => {
		const pipeline = new HookPipeline([], { db });
		const emailPipeline = new EmailPipeline(pipeline);

		expect(emailPipeline.isAvailable()).toBe(false);
	});

	it("isAvailable returns true when a provider is selected", () => {
		const deliverHandler: EmailDeliverHandler = async () => {};

		const provider = createTestPlugin({
			id: "test-provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("test-provider", deliverHandler, { exclusive: true }),
			},
		});

		const pipeline = new HookPipeline([provider], { db });
		pipeline.setExclusiveSelection("email:deliver", "test-provider");

		const emailPipeline = new EmailPipeline(pipeline);
		expect(emailPipeline.isAvailable()).toBe(true);
	});

	it("throws EmailNotConfiguredError when no provider is selected", async () => {
		const pipeline = new HookPipeline([], { db });
		const emailPipeline = new EmailPipeline(pipeline);

		await expect(emailPipeline.send(createTestMessage(), "test")).rejects.toThrow(
			EmailNotConfiguredError,
		);
	});

	it("sends through the full pipeline: beforeSend → deliver → afterSend", async () => {
		const order: string[] = [];

		const beforeSendHandler: EmailBeforeSendHandler = async (event) => {
			order.push("beforeSend");
			return { ...event.message, subject: event.message.subject + " [processed]" };
		};

		const deliverHandler: EmailDeliverHandler = async (event) => {
			order.push("deliver");
			// Verify the message was transformed by beforeSend
			expect(event.message.subject).toBe("Test Subject [processed]");
		};

		const afterSendHandler: EmailAfterSendHandler = async () => {
			order.push("afterSend");
		};

		const middlewarePlugin = createTestPlugin({
			id: "middleware",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("middleware", beforeSendHandler),
			},
		});

		const providerPlugin = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const loggerPlugin = createTestPlugin({
			id: "logger",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("logger", afterSendHandler),
			},
		});

		const hookPipeline = new HookPipeline([middlewarePlugin, providerPlugin, loggerPlugin], {
			db,
		});
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);
		// Use non-system source so beforeSend hooks run
		await emailPipeline.send(createTestMessage(), "some-plugin");

		// afterSend is fire-and-forget, give it a tick
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(order).toContain("beforeSend");
		expect(order).toContain("deliver");
		// afterSend is fire-and-forget but should still run
		expect(order).toContain("afterSend");
	});

	it("cancellation in beforeSend prevents delivery", async () => {
		const deliverHandler = vi.fn() as unknown as EmailDeliverHandler;
		const afterSendHandler = vi.fn() as unknown as EmailAfterSendHandler;

		const cancellerPlugin = createTestPlugin({
			id: "canceller",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook(
					"canceller",
					(async () => false) as EmailBeforeSendHandler,
				),
			},
		});

		const providerPlugin = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const loggerPlugin = createTestPlugin({
			id: "logger",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("logger", afterSendHandler),
			},
		});

		const hookPipeline = new HookPipeline([cancellerPlugin, providerPlugin, loggerPlugin], {
			db,
		});
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);
		// Use non-system source so beforeSend hooks run (and can cancel)
		await emailPipeline.send(createTestMessage(), "some-plugin");

		// Give fire-and-forget a tick
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(deliverHandler).not.toHaveBeenCalled();
		expect(afterSendHandler).not.toHaveBeenCalled();
	});

	it("provider errors propagate to caller", async () => {
		const deliverHandler: EmailDeliverHandler = async () => {
			throw new Error("Resend API error (401): Unauthorized");
		};

		const provider = createTestPlugin({
			id: "broken-provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("broken-provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "broken-provider");

		const emailPipeline = new EmailPipeline(hookPipeline);
		await expect(emailPipeline.send(createTestMessage(), "system")).rejects.toThrow(
			"Resend API error (401): Unauthorized",
		);
	});

	it("afterSend errors do not propagate to caller", async () => {
		const deliverHandler: EmailDeliverHandler = async () => {};
		const afterSendHandler: EmailAfterSendHandler = async () => {
			throw new Error("logger crash");
		};

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});
		const logger = createTestPlugin({
			id: "broken-logger",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:afterSend": createTestHook("broken-logger", afterSendHandler),
			},
		});

		const hookPipeline = new HookPipeline([provider, logger], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);

		// Should NOT throw even though afterSend handler throws
		await emailPipeline.send(createTestMessage(), "system");

		// Give fire-and-forget a tick
		await new Promise((resolve) => setTimeout(resolve, 10));
	});
});

// ---------------------------------------------------------------------------
// Dev Console Email Provider
// ---------------------------------------------------------------------------

describe("Dev Console Email Provider", () => {
	beforeEach(() => {
		clearDevEmails();
	});

	it("captures emails to in-memory store", async () => {
		const event = {
			message: createTestMessage({ to: "dev@example.com", subject: "Dev Test" }),
			source: "system",
		};

		await devConsoleEmailDeliver(event, {} as PluginContext);

		const emails = getDevEmails();
		expect(emails).toHaveLength(1);
		expect(emails[0]!.message.to).toBe("dev@example.com");
		expect(emails[0]!.message.subject).toBe("Dev Test");
		expect(emails[0]!.source).toBe("system");
		expect(emails[0]!.sentAt).toBeDefined();
	});

	it("returns emails in most-recent-first order", async () => {
		await devConsoleEmailDeliver(
			{ message: createTestMessage({ subject: "First" }), source: "system" },
			{} as PluginContext,
		);
		await devConsoleEmailDeliver(
			{ message: createTestMessage({ subject: "Second" }), source: "system" },
			{} as PluginContext,
		);

		const emails = getDevEmails();
		expect(emails).toHaveLength(2);
		expect(emails[0]!.message.subject).toBe("Second");
		expect(emails[1]!.message.subject).toBe("First");
	});

	it("caps stored emails at 100", async () => {
		for (let i = 0; i < 110; i++) {
			await devConsoleEmailDeliver(
				{ message: createTestMessage({ subject: `Email ${i}` }), source: "system" },
				{} as PluginContext,
			);
		}

		const emails = getDevEmails();
		expect(emails).toHaveLength(100);
		// Most recent should be email 109
		expect(emails[0]!.message.subject).toBe("Email 109");
		// Oldest should be email 10 (0-9 were evicted)
		expect(emails[99]!.message.subject).toBe("Email 10");
	});

	it("clearDevEmails removes all stored emails", async () => {
		await devConsoleEmailDeliver(
			{ message: createTestMessage(), source: "system" },
			{} as PluginContext,
		);

		expect(getDevEmails()).toHaveLength(1);
		clearDevEmails();
		expect(getDevEmails()).toHaveLength(0);
	});

	it("has correct plugin ID", () => {
		expect(DEV_CONSOLE_EMAIL_PLUGIN_ID).toBe("emdash-console-email");
	});
});

// ---------------------------------------------------------------------------
// definePlugin — email capabilities
// ---------------------------------------------------------------------------

describe("definePlugin — email capabilities", () => {
	it("accepts email:send as a valid capability", async () => {
		const { definePlugin } = await import("../../../src/plugins/define-plugin.js");

		const plugin = definePlugin({
			id: "email-consumer",
			version: "1.0.0",
			capabilities: ["email:send"],
		});

		expect(plugin.capabilities).toContain("email:send");
	});

	it("accepts email:provide as a valid capability", async () => {
		const { definePlugin } = await import("../../../src/plugins/define-plugin.js");

		const plugin = definePlugin({
			id: "email-provider",
			version: "1.0.0",
			capabilities: ["hooks.email-transport:register"],
		});

		expect(plugin.capabilities).toContain("hooks.email-transport:register");
	});

	it("accepts email:intercept as a valid capability", async () => {
		const { definePlugin } = await import("../../../src/plugins/define-plugin.js");

		const plugin = definePlugin({
			id: "email-interceptor",
			version: "1.0.0",
			capabilities: ["hooks.email-events:register"],
		});

		expect(plugin.capabilities).toContain("hooks.email-events:register");
	});
});

// ---------------------------------------------------------------------------
// Capability enforcement — email hooks
// ---------------------------------------------------------------------------

describe("Capability enforcement — email hooks", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("skips email:beforeSend hook without email:intercept capability", async () => {
		const handler = vi.fn(async (event: EmailBeforeSendEvent) => event.message);

		const plugin = createTestPlugin({
			id: "no-cap",
			capabilities: [], // missing email:intercept
			hooks: {
				"email:beforeSend": createTestHook("no-cap", handler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		await pipeline.runEmailBeforeSend(createTestMessage(), "test");

		expect(handler).not.toHaveBeenCalled();
	});

	it("skips email:afterSend hook without email:intercept capability", async () => {
		const handler = vi.fn(async () => {});

		const plugin = createTestPlugin({
			id: "no-cap",
			capabilities: [], // missing email:intercept
			hooks: {
				"email:afterSend": createTestHook("no-cap", handler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		await pipeline.runEmailAfterSend(createTestMessage(), "test");

		expect(handler).not.toHaveBeenCalled();
	});

	it("skips email:deliver hook without email:provide capability", () => {
		const handler = vi.fn(async () => {});

		const plugin = createTestPlugin({
			id: "no-cap",
			capabilities: ["email:send"], // has send but not provide
			hooks: {
				"email:deliver": createTestHook("no-cap", handler, { exclusive: true }),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		// The hook should not be registered, so no exclusive provider is available
		const emailPipeline = new EmailPipeline(pipeline);
		expect(emailPipeline.isAvailable()).toBe(false);
	});

	it("email:send capability alone does not allow registering email hooks", async () => {
		const beforeHandler = vi.fn(async (event: EmailBeforeSendEvent) => event.message);
		const afterHandler = vi.fn(async () => {});

		const plugin = createTestPlugin({
			id: "send-only",
			capabilities: ["email:send"], // can send, but can't intercept or provide
			hooks: {
				"email:beforeSend": createTestHook("send-only", beforeHandler),
				"email:afterSend": createTestHook("send-only", afterHandler),
			},
		});

		const pipeline = new HookPipeline([plugin], { db });
		await pipeline.runEmailBeforeSend(createTestMessage(), "test");
		await pipeline.runEmailAfterSend(createTestMessage(), "test");

		expect(beforeHandler).not.toHaveBeenCalled();
		expect(afterHandler).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Integration: ctx.email gating
// ---------------------------------------------------------------------------

describe("ctx.email gating", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("ctx.email is undefined without email:send capability", async () => {
		// Create a provider and pipeline
		const deliverHandler: EmailDeliverHandler = async () => {};
		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});
		const hookPipeline = new HookPipeline([provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");
		const emailPipeline = new EmailPipeline(hookPipeline);

		// Plugin WITHOUT email:send capability
		const plugin = createTestPlugin({
			id: "no-email",
			capabilities: [],
		});

		const factory = new PluginContextFactory({ db, emailPipeline });
		const ctx = factory.createContext(plugin);

		expect(ctx.email).toBeUndefined();
	});

	it("ctx.email is defined with email:send capability and available provider", async () => {
		// Create a provider and pipeline
		const deliverHandler: EmailDeliverHandler = async () => {};
		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});
		const hookPipeline = new HookPipeline([provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");
		const emailPipeline = new EmailPipeline(hookPipeline);

		// Plugin WITH email:send capability
		const plugin = createTestPlugin({
			id: "email-consumer",
			capabilities: ["email:send"],
		});

		const factory = new PluginContextFactory({ db, emailPipeline });
		const ctx = factory.createContext(plugin);

		expect(ctx.email).toBeDefined();
		expect(typeof ctx.email!.send).toBe("function");
	});

	it("ctx.email is undefined when no provider is configured", async () => {
		// Pipeline with no providers
		const hookPipeline = new HookPipeline([], { db });
		const emailPipeline = new EmailPipeline(hookPipeline);

		// Plugin WITH email:send capability but no provider configured
		const plugin = createTestPlugin({
			id: "email-consumer",
			capabilities: ["email:send"],
		});

		const factory = new PluginContextFactory({ db, emailPipeline });
		const ctx = factory.createContext(plugin);

		expect(ctx.email).toBeUndefined();
	});

	it("ctx.email.send() routes through pipeline with plugin ID as source", async () => {
		let receivedSource: string | undefined;
		const deliverHandler: EmailDeliverHandler = async (event) => {
			receivedSource = event.source;
		};

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const consumer = createTestPlugin({
			id: "forms-plugin",
			capabilities: ["email:send"],
		});

		const hookPipeline = new HookPipeline([provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");
		const emailPipeline = new EmailPipeline(hookPipeline);

		const factory = new PluginContextFactory({ db, emailPipeline });
		const ctx = factory.createContext(consumer);

		await ctx.email!.send(createTestMessage());

		expect(receivedSource).toBe("forms-plugin");
	});
});

// ---------------------------------------------------------------------------
// Integration: Full pipeline with PluginManager
// ---------------------------------------------------------------------------

describe("Email Pipeline — full integration with PluginManager", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
		await runMigrations(db);
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("exclusive hook auto-selects single email:deliver provider", async () => {
		const deliverHandler: EmailDeliverHandler = async () => {};

		const manager = new PluginManager({ db });
		manager.register({
			id: "email-resend",
			version: "1.0.0",
			capabilities: ["network:request", "hooks.email-transport:register"],
			allowedHosts: ["api.resend.com"],
			hooks: {
				"email:deliver": {
					exclusive: true,
					handler: deliverHandler,
				},
			},
		});

		await manager.activate("email-resend");

		const selection = await manager.getExclusiveHookSelection("email:deliver");
		expect(selection).toBe("email-resend");
	});
});

// ---------------------------------------------------------------------------
// Integration: Dev console as pipeline provider
// ---------------------------------------------------------------------------

describe("Dev Console — as pipeline provider", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(async () => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
		await runMigrations(db);
		clearDevEmails();
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
		clearDevEmails();
	});

	it("sends email through dev console provider end-to-end", async () => {
		const devProvider = createTestPlugin({
			id: DEV_CONSOLE_EMAIL_PLUGIN_ID,
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook(DEV_CONSOLE_EMAIL_PLUGIN_ID, devConsoleEmailDeliver, {
					exclusive: true,
				}),
			},
		});

		const hookPipeline = new HookPipeline([devProvider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", DEV_CONSOLE_EMAIL_PLUGIN_ID);

		const emailPipeline = new EmailPipeline(hookPipeline);
		expect(emailPipeline.isAvailable()).toBe(true);

		await emailPipeline.send(
			createTestMessage({ to: "test@dev.local", subject: "Dev Pipeline Test" }),
			"system",
		);

		const emails = getDevEmails();
		expect(emails).toHaveLength(1);
		expect(emails[0]!.message.to).toBe("test@dev.local");
		expect(emails[0]!.message.subject).toBe("Dev Pipeline Test");
		expect(emails[0]!.source).toBe("system");
	});

	it("beforeSend middleware modifies message before dev console receives it", async () => {
		const footerMiddleware = createTestPlugin({
			id: "footer-middleware",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("footer-middleware", (async (
					event: EmailBeforeSendEvent,
				) => {
					return {
						...event.message,
						text: event.message.text + "\n\n-- Footer",
					};
				}) as EmailBeforeSendHandler),
			},
		});

		const devProvider = createTestPlugin({
			id: DEV_CONSOLE_EMAIL_PLUGIN_ID,
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook(DEV_CONSOLE_EMAIL_PLUGIN_ID, devConsoleEmailDeliver, {
					exclusive: true,
				}),
			},
		});

		const hookPipeline = new HookPipeline([footerMiddleware, devProvider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", DEV_CONSOLE_EMAIL_PLUGIN_ID);

		const emailPipeline = new EmailPipeline(hookPipeline);
		// Use non-system source so beforeSend hooks run
		await emailPipeline.send(createTestMessage({ text: "Hello world" }), "some-plugin");

		const emails = getDevEmails();
		expect(emails).toHaveLength(1);
		expect(emails[0]!.message.text).toBe("Hello world\n\n-- Footer");
	});
});

// ---------------------------------------------------------------------------
// Email Pipeline Security
// ---------------------------------------------------------------------------

describe("EmailPipeline — recursion guard", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("throws EmailRecursionError on re-entrant send", async () => {
		// A plugin that tries to send an email from within email:beforeSend
		let emailPipeline: EmailPipeline;
		const recursiveHandler: EmailBeforeSendHandler = async (event) => {
			// This should throw — we're already inside send()
			await emailPipeline.send(createTestMessage({ to: "other@example.com" }), "sneaky-plugin");
			return event.message;
		};

		const deliverHandler: EmailDeliverHandler = async () => {};

		const plugin = createTestPlugin({
			id: "recursive-plugin",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("recursive-plugin", recursiveHandler, {
					errorPolicy: "abort",
				}),
			},
		});

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([plugin, provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		emailPipeline = new EmailPipeline(hookPipeline);

		// Use non-system source so beforeSend hooks run and trigger recursion
		await expect(emailPipeline.send(createTestMessage(), "some-plugin")).rejects.toThrow(
			EmailRecursionError,
		);
	});

	it("resets depth counter after error so subsequent sends work", async () => {
		let callCount = 0;
		let emailPipeline: EmailPipeline;

		const recursiveHandler: EmailBeforeSendHandler = async (event) => {
			callCount++;
			if (callCount === 1) {
				// First call: try to recurse (will fail)
				await emailPipeline.send(createTestMessage(), "sneaky");
			}
			return event.message;
		};

		const deliverHandler: EmailDeliverHandler = async () => {};

		const plugin = createTestPlugin({
			id: "recursive-plugin",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("recursive-plugin", recursiveHandler, {
					errorPolicy: "abort",
				}),
			},
		});

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([plugin, provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");
		emailPipeline = new EmailPipeline(hookPipeline);

		// First send triggers recursion error (non-system so beforeSend runs)
		await expect(emailPipeline.send(createTestMessage(), "some-plugin")).rejects.toThrow(
			EmailRecursionError,
		);

		// Subsequent sends should work (ALS context ended after the first call)
		callCount = 10; // Skip the recursion branch
		await emailPipeline.send(createTestMessage(), "some-plugin");
	});
});

describe("EmailPipeline — system email protection", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("system emails skip email:beforeSend hooks entirely", async () => {
		const interceptorHandler = vi.fn(async (event: EmailBeforeSendEvent) => {
			// A malicious interceptor that rewrites the body to steal auth tokens
			return { ...event.message, html: "<a href='https://evil.com'>Click here</a>" };
		});

		const deliverHandler = vi.fn(async () => {}) as unknown as EmailDeliverHandler;

		const interceptor = createTestPlugin({
			id: "evil-interceptor",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("evil-interceptor", interceptorHandler),
			},
		});

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([interceptor, provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);

		// System email should bypass beforeSend entirely
		await emailPipeline.send(
			createTestMessage({
				to: "admin@example.com",
				html: "<a href='https://emdash.dev/magic?token=secret'>Login</a>",
			}),
			"system",
		);

		// The interceptor should NOT have been called
		expect(interceptorHandler).not.toHaveBeenCalled();
		// The deliver handler SHOULD have been called with the original message
		expect(deliverHandler).toHaveBeenCalledTimes(1);
		expect(deliverHandler).toHaveBeenCalledWith(
			expect.objectContaining({
				message: expect.objectContaining({
					to: "admin@example.com",
					html: expect.stringContaining("token=secret"),
				}),
			}),
			expect.anything(),
		);
	});

	it("system emails cannot be cancelled by middleware", async () => {
		const cancelHandler: EmailBeforeSendHandler = async () => false;
		const deliverHandler = vi.fn(async () => {}) as unknown as EmailDeliverHandler;

		const canceller = createTestPlugin({
			id: "canceller",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("canceller", cancelHandler),
			},
		});

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([canceller, provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);
		await emailPipeline.send(createTestMessage({ to: "admin@example.com" }), "system");

		// System email must be delivered regardless
		expect(deliverHandler).toHaveBeenCalledTimes(1);
	});

	it("non-system emails still go through beforeSend middleware", async () => {
		const handler = vi.fn(async (event: EmailBeforeSendEvent) => {
			return { ...event.message, subject: event.message.subject + " [modified]" };
		});

		const deliverHandler = vi.fn(async () => {}) as unknown as EmailDeliverHandler;

		const interceptor = createTestPlugin({
			id: "interceptor",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("interceptor", handler),
			},
		});

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([interceptor, provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);
		await emailPipeline.send(createTestMessage(), "some-plugin");

		// Non-system emails still pass through beforeSend
		expect(handler).toHaveBeenCalledTimes(1);
		expect(deliverHandler).toHaveBeenCalledTimes(1);
	});

	it("allows non-system email recipient changes", async () => {
		const redirectHandler: EmailBeforeSendHandler = async (event) => {
			return { ...event.message, to: "different@example.com" };
		};

		const deliverHandler = vi.fn(async () => {}) as unknown as EmailDeliverHandler;

		const interceptor = createTestPlugin({
			id: "redirector",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("redirector", redirectHandler),
			},
		});

		const provider = createTestPlugin({
			id: "provider",
			capabilities: ["hooks.email-transport:register"],
			hooks: {
				"email:deliver": createTestHook("provider", deliverHandler, { exclusive: true }),
			},
		});

		const hookPipeline = new HookPipeline([interceptor, provider], { db });
		hookPipeline.setExclusiveSelection("email:deliver", "provider");

		const emailPipeline = new EmailPipeline(hookPipeline);

		// Non-system source — recipient change is allowed
		await emailPipeline.send(createTestMessage(), "some-plugin");
		expect(deliverHandler).toHaveBeenCalledTimes(1);
	});
});

describe("EmailPipeline — cancellation audit", () => {
	let db: Kysely<DbSchema>;
	let sqliteDb: Database.Database;

	beforeEach(() => {
		sqliteDb = new Database(":memory:");
		db = new Kysely<DbSchema>({
			dialect: new SqliteDialect({ database: sqliteDb }),
		});
	});

	afterEach(async () => {
		await db.destroy();
		sqliteDb.close();
	});

	it("logs an info message when a non-system email is cancelled", async () => {
		const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});

		const cancelHandler: EmailBeforeSendHandler = async () => false;

		const plugin = createTestPlugin({
			id: "filter-plugin",
			capabilities: ["hooks.email-events:register"],
			hooks: {
				"email:beforeSend": createTestHook("filter-plugin", cancelHandler),
			},
		});

		const hookPipeline = new HookPipeline([plugin], { db });
		const emailPipeline = new EmailPipeline(hookPipeline);

		await emailPipeline.send(createTestMessage({ to: "user@example.com" }), "some-plugin");

		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("filter-plugin"));
		expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining("user@example.com"));

		infoSpy.mockRestore();
	});
});
