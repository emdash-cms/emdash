import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { generateEncryptionKey, parseEncryptionKeys } from "../../../src/config/secrets.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import {
	PluginSettingEncryptionError,
	createPluginSecretRedactor,
	createSettingsAccess,
	decryptPluginSetting,
	encryptPluginSetting,
	isEncryptedPluginSetting,
} from "../../../src/plugins/settings.js";
import type { SettingField } from "../../../src/plugins/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const PLUGIN_ID = "did:plc:settings-test/plugin";
const SCHEMA: Record<string, SettingField> = {
	apiKey: { type: "secret", label: "API key" },
	enabled: { type: "boolean", label: "Enabled" },
};

describe("plugin settings encryption", () => {
	let db: Kysely<Database>;
	let repo: OptionsRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		repo = new OptionsRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("stores a versioned AES-GCM envelope and returns the plaintext", async () => {
		const keys = await parseEncryptionKeys(generateEncryptionKey());
		const settings = createSettingsAccess(repo, PLUGIN_ID, SCHEMA, keys);

		await settings.set("apiKey", "github-secret-value");

		const raw = await repo.get(`plugin:${PLUGIN_ID}:settings:apiKey`);
		expect(isEncryptedPluginSetting(raw)).toBe(true);
		expect(raw).toMatchObject({ $emdash: "plugin-setting", v: 1 });
		expect(JSON.stringify(raw)).not.toContain("github-secret-value");
		await expect(settings.get("apiKey")).resolves.toBe("github-secret-value");
	});

	it("binds ciphertext to both the plugin ID and setting key", async () => {
		const keys = await parseEncryptionKeys(generateEncryptionKey());
		const envelope = await encryptPluginSetting(PLUGIN_ID, "apiKey", "bound-secret", keys);

		await expect(decryptPluginSetting(PLUGIN_ID, "apiKey", envelope, keys)).resolves.toBe(
			"bound-secret",
		);
		await expect(
			decryptPluginSetting("did:plc:other/plugin", "apiKey", envelope, keys),
		).rejects.toMatchObject({ code: "PLUGIN_SETTING_DECRYPTION_FAILED" });
		await expect(decryptPluginSetting(PLUGIN_ID, "otherKey", envelope, keys)).rejects.toMatchObject(
			{ code: "PLUGIN_SETTING_DECRYPTION_FAILED" },
		);
	});

	it("encrypts with the first key and decrypts by kid during rotation", async () => {
		const oldKey = generateEncryptionKey();
		const newKey = generateEncryptionKey();
		const oldKeys = await parseEncryptionKeys(oldKey);
		const rotatedKeys = await parseEncryptionKeys(`${newKey},${oldKey}`);
		const oldEnvelope = await encryptPluginSetting(PLUGIN_ID, "apiKey", "old-secret", oldKeys);
		const newEnvelope = await encryptPluginSetting(PLUGIN_ID, "apiKey", "new-secret", rotatedKeys);

		expect(newEnvelope.kid).toBe(rotatedKeys?.[0]?.kid);
		await expect(decryptPluginSetting(PLUGIN_ID, "apiKey", oldEnvelope, rotatedKeys)).resolves.toBe(
			"old-secret",
		);
		await expect(decryptPluginSetting(PLUGIN_ID, "apiKey", newEnvelope, rotatedKeys)).resolves.toBe(
			"new-secret",
		);
	});

	it("fails closed for missing, unknown, and tampered keys without including plaintext", async () => {
		const keys = await parseEncryptionKeys(generateEncryptionKey());
		const wrongKeys = await parseEncryptionKeys(generateEncryptionKey());
		const envelope = await encryptPluginSetting(PLUGIN_ID, "apiKey", "never-log-this", keys);
		const tampered = {
			...envelope,
			ciphertext: `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`,
		};

		for (const attempt of [
			decryptPluginSetting(PLUGIN_ID, "apiKey", envelope, null),
			decryptPluginSetting(PLUGIN_ID, "apiKey", envelope, wrongKeys),
			decryptPluginSetting(PLUGIN_ID, "apiKey", tampered, keys),
		]) {
			const error = await attempt.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(PluginSettingEncryptionError);
			expect(String(error)).not.toContain("never-log-this");
		}
	});

	it("reads legacy plaintext and encrypts it when it is saved again", async () => {
		const keys = await parseEncryptionKeys(generateEncryptionKey());
		await repo.set(`plugin:${PLUGIN_ID}:settings:apiKey`, "legacy-plaintext");
		const settings = createSettingsAccess(repo, PLUGIN_ID, SCHEMA, keys);

		await expect(settings.get("apiKey")).resolves.toBe("legacy-plaintext");
		await settings.set("apiKey", "legacy-plaintext");

		const raw = await repo.get(`plugin:${PLUGIN_ID}:settings:apiKey`);
		expect(isEncryptedPluginSetting(raw)).toBe(true);
		expect(JSON.stringify(raw)).not.toContain("legacy-plaintext");
	});

	it("encrypts compare-and-set writes and preserves stale-revision conflicts", async () => {
		const keys = await parseEncryptionKeys(generateEncryptionKey());
		const settings = createSettingsAccess(repo, PLUGIN_ID, SCHEMA, keys);
		await settings.set("apiKey", "first");
		const current = await settings.getVersioned<string>("apiKey");
		expect(current?.value).toBe("first");

		const winner = await settings.compareAndSet("apiKey", current!.revision, "winner");
		expect(winner.applied).toBe(true);
		const stale = await settings.compareAndSet("apiKey", current!.revision, "stale");
		expect(stale).toEqual({ applied: false });
		await expect(settings.get("apiKey")).resolves.toBe("winner");

		const raw = await repo.get(`plugin:${PLUGIN_ID}:settings:apiKey`);
		expect(JSON.stringify(raw)).not.toContain("winner");
		expect(JSON.stringify(raw)).not.toContain("stale");
	});

	it("leaves non-secret settings as ordinary JSON", async () => {
		const settings = createSettingsAccess(repo, PLUGIN_ID, SCHEMA, null);
		await settings.set("enabled", true);
		await expect(settings.get("enabled")).resolves.toBe(true);
		await expect(repo.get(`plugin:${PLUGIN_ID}:settings:enabled`)).resolves.toBe(true);
	});

	it("bounds log-redaction history per declared setting", () => {
		const redactor = createPluginSecretRedactor();
		redactor.add("apiKey", "secret-a");
		redactor.add("apiKey", "secret-b");
		redactor.add("apiKey", "secret-b");
		expect(redactor.redact("secret-a secret-b")).toBe("[REDACTED] [REDACTED]");

		for (let index = 0; index < 100; index++) redactor.add("apiKey", `secret-${index}`);

		expect(redactor.redact("secret-97 secret-98 secret-99")).toBe(
			"secret-97 [REDACTED] [REDACTED]",
		);
	});

	it("does not evaluate secret-bearing tags on non-plain log objects", () => {
		const redactor = createPluginSecretRedactor();
		redactor.add("apiKey", "tagged-secret");
		const value = new Date(0);
		Object.defineProperty(value, Symbol.toStringTag, { value: "tagged-secret" });

		expect(redactor.redact(value)).toBe("[NonPlainObject]");
	});
});
