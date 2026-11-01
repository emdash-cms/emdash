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
		get: async (key: string) => values.get(key) ?? null,
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
	vi.restoreAllMocks();
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

	it("stores credentials only after AI Search accepts them and has the instance", async () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", ENCRYPTION_KEY);
		const input = { accountId: "account", apiToken: "token" };
		const refused = async () => {
			throw new ProviderError("unauthorized", "Authentication error");
		};
		const save = (
			verify: () => Promise<void>,
			ensureInstance: () => Promise<{ created: boolean }>,
		) => {
			const { ctx, values } = memorySettings();
			const saved = saveCredentials(ctx, options, input, {
				ensureInstance: true,
				env: {},
				connect: () => ({ verify, ensureInstance }),
			});
			return { saved, values };
		};

		const badToken = save(refused, async () => ({ created: false }));
		await expect(badToken.saved).rejects.toMatchObject({ reason: "unauthorized" });
		const cannotCreate = save(async () => {}, refused);
		await expect(cannotCreate.saved).rejects.toMatchObject({ reason: "unauthorized" });
		const accepted = save(
			async () => {},
			async () => ({ created: true }),
		);
		expect(await accepted.saved).toEqual({ created: true, accountChanged: true });

		expect(badToken.values.size).toBe(0);
		expect(cannotCreate.values.size).toBe(0);
		expect(Object.fromEntries(accepted.values)).toEqual(input);
	});

	it("keeps the stored account ID when the stored token cannot be decrypted", async () => {
		const { ctx } = memorySettings({ accountId: "stored-account", apiToken: "encrypted" });
		ctx.settings.list = async () => {
			throw new Error("Plugin secret setting could not be decrypted");
		};
		vi.spyOn(console, "error").mockImplementation(() => {});

		const provider = await openProvider(ctx, options, {
			binding: null,
			env: { [ENV.apiToken]: "env-token" },
		});

		expect(provider?.kind).toBe("rest");
	});

	it("leaves the stored account unchanged when the token cannot be saved, and reports the change on retry", async () => {
		const saved = { accountId: "old-account", apiToken: "old-token" };
		const { ctx, values } = memorySettings(saved);
		const set = ctx.settings.set;
		ctx.settings.set = async (key, value) => {
			if (key === "apiToken") throw new Error("EMDASH_ENCRYPTION_KEY is not set");
			await set(key, value);
		};
		// The first attempt creates the instance; a retry finds it.
		let exists = false;
		const save = () =>
			saveCredentials(
				ctx,
				options,
				{ accountId: "new-account", apiToken: "new-token" },
				{
					ensureInstance: true,
					env: {},
					connect: () => ({
						verify: async () => {},
						ensureInstance: async () => ({ created: !exists && (exists = true) }),
					}),
				},
			);

		await expect(save()).rejects.toThrow("EMDASH_ENCRYPTION_KEY");
		expect(Object.fromEntries(values)).toEqual(saved);

		ctx.settings.set = set;
		expect(await save()).toEqual({ created: false, accountChanged: true });
	});
});
