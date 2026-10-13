import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadDevEnv } from "../../../../src/astro/integration/dev-env.js";
import { resolvePluginEncryptionKeys } from "../../../../src/config/secrets.js";
import { encryptPluginSetting } from "../../../../src/plugins/settings.js";

const EMDASH_VAR_NAMES = [
	"EMDASH_ENCRYPTION_KEY",
	"EMDASH_PREVIEW_SECRET",
	"PREVIEW_SECRET",
	"EMDASH_IP_SALT",
	"EMDASH_AUTH_SECRET",
	"AUTH_SECRET",
	"EMDASH_SITE_URL",
	"SITE_URL",
];

describe("loadDevEnv", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "emdash-dev-env-"));
		for (const name of EMDASH_VAR_NAMES) {
			vi.stubEnv(name, "");
		}
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("copies EMDASH_ENCRYPTION_KEY from .env into process.env when absent", () => {
		const key = "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		writeFileSync(join(tempDir, ".env"), `EMDASH_ENCRYPTION_KEY=${key}\n`);

		loadDevEnv(tempDir);

		expect(process.env.EMDASH_ENCRYPTION_KEY).toBe(key);
	});

	it("does not copy other EmDash variables such as SITE_URL", () => {
		writeFileSync(
			join(tempDir, ".env"),
			[
				"EMDASH_ENCRYPTION_KEY=emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
				"EMDASH_PREVIEW_SECRET=preview-value",
				"PREVIEW_SECRET=legacy-preview",
				"EMDASH_IP_SALT=ip-salt",
				"EMDASH_AUTH_SECRET=auth-secret",
				"AUTH_SECRET=legacy-auth",
				"EMDASH_SITE_URL=https://www.example.com",
				"SITE_URL=https://old.example.com",
			].join("\n"),
		);

		loadDevEnv(tempDir);

		expect(process.env.EMDASH_ENCRYPTION_KEY).toBe(
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
		expect(process.env.EMDASH_PREVIEW_SECRET).toBeFalsy();
		expect(process.env.PREVIEW_SECRET).toBeFalsy();
		expect(process.env.EMDASH_IP_SALT).toBeFalsy();
		expect(process.env.EMDASH_AUTH_SECRET).toBeFalsy();
		expect(process.env.AUTH_SECRET).toBeFalsy();
		expect(process.env.EMDASH_SITE_URL).toBeFalsy();
		expect(process.env.SITE_URL).toBeFalsy();
	});

	it("does not overwrite variables already set in process.env", () => {
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "shell-key");
		writeFileSync(join(tempDir, ".env"), "EMDASH_ENCRYPTION_KEY=envfile-key\n");

		loadDevEnv(tempDir);

		expect(process.env.EMDASH_ENCRYPTION_KEY).toBe("shell-key");
	});

	it("ignores non-EmDash variables", () => {
		writeFileSync(
			join(tempDir, ".env"),
			"EMDASH_ENCRYPTION_KEY=emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\nUNRELATED=should-not-appear\n",
		);

		loadDevEnv(tempDir);

		expect(process.env.UNRELATED).toBeUndefined();
	});

	it("is a no-op when .env is missing", () => {
		loadDevEnv(tempDir);

		for (const name of EMDASH_VAR_NAMES) {
			expect(process.env[name]).toBeFalsy();
		}
	});

	it("handles quoted values", () => {
		writeFileSync(
			join(tempDir, ".env"),
			[
				`EMDASH_ENCRYPTION_KEY="emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"`,
				`UNRELATED='single-quoted'`,
			].join("\n"),
		);

		loadDevEnv(tempDir);

		expect(process.env.EMDASH_ENCRYPTION_KEY).toBe(
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
		expect(process.env.UNRELATED).toBeUndefined();
	});

	it("supports a URL-shaped root argument", () => {
		const key = "emdash_enc_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
		writeFileSync(join(tempDir, ".env"), `EMDASH_ENCRYPTION_KEY=${key}\n`);

		loadDevEnv(new URL(`file://${tempDir}/`));

		expect(process.env.EMDASH_ENCRYPTION_KEY).toBe(key);
	});

	it("ignores inline comments", () => {
		writeFileSync(
			join(tempDir, ".env"),
			"EMDASH_ENCRYPTION_KEY=emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA # not part of value\n",
		);

		loadDevEnv(tempDir);

		expect(process.env.EMDASH_ENCRYPTION_KEY).toBe(
			"emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		);
	});

	it("makes the key usable by the plugin secret encryption path", async () => {
		const key = "emdash_enc_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
		writeFileSync(join(tempDir, ".env"), `EMDASH_ENCRYPTION_KEY=${key}\n`);

		loadDevEnv(tempDir);

		const keys = await resolvePluginEncryptionKeys();
		expect(keys).toHaveLength(1);
		if (!keys) return;
		expect(keys[0].raw).toBe(key);

		const encrypted = await encryptPluginSetting("plugin/test", "apiToken", "secret-value", keys);
		expect(encrypted.$emdash).toBe("plugin-setting");
	});
});
