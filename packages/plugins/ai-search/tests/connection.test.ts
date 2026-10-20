import type { SettingsAccess } from "emdash";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeConnection, openProvider, saveCredentials } from "../src/connection.js";
import { ENV } from "../src/env.js";
import { resolveOptions } from "../src/options.js";
import { ProviderError } from "../src/ports/ai-search.js";

const options = resolveOptions();

/** 32 bytes, base64url-encoded, as `EMDASH_ENCRYPTION_KEY` takes them. */
const ENCRYPTION_KEY = `emdash_enc_v1_${"A".repeat(43)}`;

function memorySettings(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	let lists = 0;
	const settings = {
		set: async (key: string, value: unknown) => void values.set(key, String(value)),
		delete: async (key: string) => values.delete(key),
		list: async () => {
			lists++;
			return Array.from(values, ([key, value]) => ({ key, value }));
		},
	} as unknown as SettingsAccess;
	return { ctx: { settings }, values, lists: () => lists };
}

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("connection", () => {
	it("prefers the binding, then environment credentials, filling gaps from settings", async () => {
		const binding = {} as AiSearchNamespace;
		const env = { [ENV.accountId]: "account", [ENV.apiToken]: "token" };
		const fromEnv = memorySettings();
		const partial = memorySettings({ apiToken: "stored-token" });

		expect((await openProvider(fromEnv.ctx, options, { binding, env }))?.kind).toBe("binding");
		expect((await openProvider(fromEnv.ctx, options, { binding: null, env }))?.kind).toBe("rest");
		expect(fromEnv.lists()).toBe(0);
		const filled = await openProvider(partial.ctx, options, {
			binding: null,
			env: { [ENV.accountId]: "account" },
		});
		expect(filled?.kind).toBe("rest");
	});

	it("describes the connection without revealing stored or environment secrets", async () => {
		const { ctx } = memorySettings({ apiToken: "stored-token" });

		const info = await describeConnection(ctx, { [ENV.accountId]: "env-account" });

		expect(info).toMatchObject({ accountId: { source: "env" }, apiToken: { source: "settings" } });
		expect(JSON.stringify(info)).not.toContain("stored-token");
		expect(JSON.stringify(info)).not.toContain("env-account");
	});

	it("stores credentials only after AI Search accepts them", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
		const input = { accountId: "account", apiToken: "token" };
		const rejected = memorySettings();
		const accepted = memorySettings();
		const refuse = () => ({
			verify: async () => {
				throw new ProviderError("unauthorized", "Authentication error");
			},
		});
		const accept = () => ({ verify: async () => {} });

		await expect(saveCredentials(rejected.ctx, options, input, {}, refuse)).rejects.toMatchObject({
			reason: "unauthorized",
		});
		await saveCredentials(accepted.ctx, options, input, {}, accept);

		expect(rejected.values.size).toBe(0);
		expect(Object.fromEntries(accepted.values)).toEqual(input);
	});
});
