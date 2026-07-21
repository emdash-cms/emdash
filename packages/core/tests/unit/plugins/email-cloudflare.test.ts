/**
 * Unit tests for the built-in Cloudflare Email provider.
 *
 * Covers config loading (DB / env / fallback), the deliver handler,
 * and the built-in plugin registration.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { Kysely } from "kysely";

import {
	CLOUDFLARE_EMAIL_PLUGIN_ID,
	createCloudflareEmailDeliver,
	createCloudflareEmailPlugin,
	loadCloudflareConfig,
	loadCloudflareConfigFromDb,
	loadCloudflareConfigFromEnv,
	saveCloudflareConfigToDb,
	type CloudflareEmailConfig,
} from "../../../src/plugins/email-cloudflare.js";
import type { EmailDeliverEvent, PluginContext } from "../../../src/plugins/types.js";
import type { Database as DatabaseSchema } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseConfig: CloudflareEmailConfig = {
	fromName: "Site",
	fromEmail: "noreply@example.com",
	replyTo: "support@example.com",
};

const mockCtx = {
	log: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
} as unknown as PluginContext;

function makeMessage(): EmailDeliverEvent["message"] {
	return {
		to: "recipient@example.com",
		subject: "Hello",
		text: "Plain body",
		html: "<p>HTML body</p>",
	};
}

/** Create a mock send_email binding. */
function makeBinding() {
	const send = vi.fn(async () => ({ messageId: "msg-123" }));
	return { send };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("loadCloudflareConfigFromEnv", () => {
	it("returns null when EMAIL_FROM_NAME is unset", () => {
		delete process.env.EMAIL_FROM_NAME;
		delete process.env.EMAIL_FROM_EMAIL;
		expect(loadCloudflareConfigFromEnv()).toBeNull();
	});

	it("returns null when EMAIL_FROM_EMAIL is unset", () => {
		process.env.EMAIL_FROM_NAME = "Site";
		delete process.env.EMAIL_FROM_EMAIL;
		expect(loadCloudflareConfigFromEnv()).toBeNull();
		delete process.env.EMAIL_FROM_NAME;
	});

	it("parses a complete config", () => {
		process.env.EMAIL_FROM_NAME = "Site";
		process.env.EMAIL_FROM_EMAIL = "noreply@example.com";
		process.env.EMAIL_REPLY_TO = "support@example.com";

		const config = loadCloudflareConfigFromEnv();
		expect(config).toEqual({
			fromName: "Site",
			fromEmail: "noreply@example.com",
			replyTo: "support@example.com",
		});

		delete process.env.EMAIL_FROM_NAME;
		delete process.env.EMAIL_FROM_EMAIL;
		delete process.env.EMAIL_REPLY_TO;
	});

	it("omits replyTo when not set", () => {
		process.env.EMAIL_FROM_NAME = "Site";
		process.env.EMAIL_FROM_EMAIL = "noreply@example.com";
		delete process.env.EMAIL_REPLY_TO;

		const config = loadCloudflareConfigFromEnv();
		expect(config).toEqual({
			fromName: "Site",
			fromEmail: "noreply@example.com",
		});

		delete process.env.EMAIL_FROM_NAME;
		delete process.env.EMAIL_FROM_EMAIL;
	});
});

describe("loadCloudflareConfigFromDb / saveCloudflareConfigToDb", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns null when no config is stored", async () => {
		const config = await loadCloudflareConfigFromDb(db);
		expect(config).toBeNull();
	});

	it("saves and loads a full config", async () => {
		await saveCloudflareConfigToDb(db, baseConfig);
		const loaded = await loadCloudflareConfigFromDb(db);

		expect(loaded).toEqual(baseConfig);
	});

	it("clears replyTo when not provided on save", async () => {
		await saveCloudflareConfigToDb(db, baseConfig);
		await saveCloudflareConfigToDb(db, {
			fromName: "Site",
			fromEmail: "noreply@example.com",
		});
		const loaded = await loadCloudflareConfigFromDb(db);
		expect(loaded?.replyTo).toBeUndefined();
	});
});

describe("loadCloudflareConfig", () => {
	let db: Kysely<DatabaseSchema>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("prefers DB config over env vars", async () => {
		process.env.EMAIL_FROM_NAME = "Env Site";
		process.env.EMAIL_FROM_EMAIL = "env@example.com";

		await saveCloudflareConfigToDb(db, baseConfig);
		const loaded = await loadCloudflareConfig(db);
		expect(loaded?.fromName).toBe("Site");

		delete process.env.EMAIL_FROM_NAME;
		delete process.env.EMAIL_FROM_EMAIL;
	});

	it("falls back to env vars when DB is empty", async () => {
		process.env.EMAIL_FROM_NAME = "Env Site";
		process.env.EMAIL_FROM_EMAIL = "env@example.com";

		const loaded = await loadCloudflareConfig(db);
		expect(loaded?.fromName).toBe("Env Site");

		delete process.env.EMAIL_FROM_NAME;
		delete process.env.EMAIL_FROM_EMAIL;
	});

	it("returns null when neither DB nor env is configured", async () => {
		delete process.env.EMAIL_FROM_NAME;
		delete process.env.EMAIL_FROM_EMAIL;
		const loaded = await loadCloudflareConfig(db);
		expect(loaded).toBeNull();
	});
});

describe("createCloudflareEmailDeliver", () => {
	it("delivers via the send_email binding", async () => {
		const binding = makeBinding();
		const deliver = createCloudflareEmailDeliver(baseConfig, async () => ({
			EMAIL: binding,
		}));

		await deliver({ message: makeMessage(), source: "test" }, mockCtx);

		expect(binding.send).toHaveBeenCalledWith({
			from: { email: "noreply@example.com", name: "Site" },
			to: "recipient@example.com",
			subject: "Hello",
			text: "Plain body",
			html: "<p>HTML body</p>",
			replyTo: "support@example.com",
		});
		expect(mockCtx.log.info).toHaveBeenCalledWith(
			"email delivered via Cloudflare Email Sending",
			expect.objectContaining({ to: "recipient@example.com", subject: "Hello" }),
		);
	});

	it("throws when the binding is missing", async () => {
		const deliver = createCloudflareEmailDeliver(baseConfig, async () => ({}));

		await expect(
			deliver({ message: makeMessage(), source: "test" }, mockCtx),
		).rejects.toThrow(/send_email binding "EMAIL" not found/);
	});

	it("throws when the binding has no send method", async () => {
		const deliver = createCloudflareEmailDeliver(baseConfig, async () => ({
			EMAIL: { notSend: true },
		}));

		await expect(
			deliver({ message: makeMessage(), source: "test" }, mockCtx),
		).rejects.toThrow(/send_email binding "EMAIL" not found/);
	});

	it("uses a custom binding name when configured", async () => {
		const binding = makeBinding();
		const deliver = createCloudflareEmailDeliver(
			{ ...baseConfig, binding: "MY_EMAIL" },
			async () => ({ MY_EMAIL: binding }),
		);

		await deliver({ message: makeMessage(), source: "test" }, mockCtx);
		expect(binding.send).toHaveBeenCalled();
	});
});

describe("createCloudflareEmailPlugin", () => {
	it("returns a plugin with the correct ID", () => {
		const plugin = createCloudflareEmailPlugin(baseConfig);
		expect(plugin.id).toBe(CLOUDFLARE_EMAIL_PLUGIN_ID);
	});

	it("throws when config is null and handler is invoked", async () => {
		const plugin = createCloudflareEmailPlugin(null);
		const hook = plugin.hooks["email:deliver"];
		expect(hook).toBeDefined();
		await expect(
			hook!.handler({ message: makeMessage(), source: "test" }, mockCtx),
		).rejects.toThrow(/Not configured/);
	});
});
