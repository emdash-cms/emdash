import { randomUUID } from "node:crypto";

import { SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { SMTP_EMAIL_PLUGIN_ID } from "../../../src/plugins/email-smtp.js";

const emailPlugin = definePlugin({
	id: "test-email-plugin",
	version: "1.0.0",
	capabilities: ["hooks.email-transport:register"],
	hooks: {
		"email:deliver": { exclusive: true, handler: async () => {} },
	},
});

function deps(plugins: RuntimeDependencies["plugins"]): RuntimeDependencies {
	return {
		config: {
			database: { entrypoint: `test-email-selection-${randomUUID()}`, config: {}, type: "sqlite" },
		},
		plugins,
		createDialect: () => new SqliteDialect({ database: new Database(":memory:") }),
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};
}

describe("built-in SMTP provider selection at runtime start", () => {
	const runtimes: EmDashRuntime[] = [];

	async function selectedProvider(plugins: RuntimeDependencies["plugins"]) {
		const runtime = await EmDashRuntime.create(deps(plugins));
		runtimes.push(runtime);
		return runtime.hooks.getExclusiveSelection("email:deliver");
	}

	beforeEach(() => {
		vi.stubEnv("DEV", false);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const runtime of runtimes.splice(0)) await runtime.stopCron();
	});

	const stubSmtpEnv = () => {
		vi.stubEnv("EMAIL_SMTP_HOST", "smtp.example.com");
		vi.stubEnv("EMAIL_SMTP_USER", "user@example.com");
		vi.stubEnv("EMAIL_SMTP_PASS", "secret");
	};

	it("selects env-configured SMTP when no email plugin is installed", async () => {
		stubSmtpEnv();
		expect(await selectedProvider([])).toBe(SMTP_EMAIL_PLUGIN_ID);
	});

	it("lets an email plugin take precedence over env-configured SMTP", async () => {
		stubSmtpEnv();
		expect(await selectedProvider([emailPlugin])).toBe("test-email-plugin");
	});

	it("never selects SMTP without env config", async () => {
		expect(await selectedProvider([])).toBeUndefined();
	});

	it("still selects a single email plugin without env config", async () => {
		expect(await selectedProvider([emailPlugin])).toBe("test-email-plugin");
	});
});
