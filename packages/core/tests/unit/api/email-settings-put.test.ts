import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { PUT as putEmailSettings } from "../../../src/astro/routes/api/settings/email.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { loadSmtpConfigFromDb } from "../../../src/plugins/email-smtp.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const TEST_ENCRYPTION_KEY = "emdash_enc_v1_U-1To8mS9tyTfAFz8KHAsCVo1fvktqbq0y5JxBiXgIU";
const OPTION_KEY = "emdash:exclusive_hook:email:deliver";

describe("PUT /_emdash/api/settings/email", () => {
	let db: Kysely<Database>;
	let hooks: {
		getExclusiveHookProviders: ReturnType<typeof vi.fn>;
		setExclusiveSelection: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		db = await setupTestDatabase();
		hooks = {
			getExclusiveHookProviders: vi
				.fn()
				.mockReturnValue([{ pluginId: "emdash-builtin-smtp" }, { pluginId: "resend" }]),
			setExclusiveSelection: vi.fn(),
		};
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.unstubAllEnvs();
	});

	const put = (body: unknown) =>
		putEmailSettings({
			request: new Request("http://localhost/_emdash/api/settings/email", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}),
			locals: {
				emdash: { db, hooks },
				user: { id: "admin-1", role: Role.ADMIN },
			},
		} as unknown as Parameters<typeof putEmailSettings>[0]);

	const smtpBody = (overrides: Record<string, unknown> = {}) => ({
		provider: "smtp",
		smtp: {
			host: "smtp.example.com",
			port: 465,
			secure: "tls",
			user: "user@example.com",
			...overrides,
		},
	});

	it("rejects the initial SMTP save without a password", async () => {
		const response = await put(smtpBody());
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		});
		expect(await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY)).toBeNull();
	});

	it("rejects SMTP port 25", async () => {
		const response = await put(smtpBody({ port: 25, pass: "s3cret" }));
		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "VALIDATION_ERROR" },
		});
		expect(await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY)).toBeNull();
	});

	it("keeps the stored password when a later save omits it", async () => {
		const first = await put(smtpBody({ pass: "s3cret" }));
		expect(first.status).toBe(200);

		const second = await put(smtpBody({ port: 587, secure: "starttls" }));
		expect(second.status).toBe(200);

		const stored = await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY);
		expect(stored?.port).toBe(587);
		expect(stored?.pass).toBe("s3cret");
	});

	it("requires the password again when the host changes", async () => {
		await put(smtpBody({ pass: "s3cret" }));

		const response = await put(smtpBody({ host: "attacker.example.com" }));
		expect(response.status).toBe(400);
		expect((await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY))?.host).toBe("smtp.example.com");
	});

	it("re-selects saved SMTP without resending its settings", async () => {
		await put(smtpBody({ pass: "s3cret" }));
		await put({ provider: "plugin", pluginId: "resend" });

		const response = await put({ provider: "smtp" });
		expect(response.status).toBe(200);
		expect(await new OptionsRepository(db).get<string>(OPTION_KEY)).toBe("emdash-builtin-smtp");
	});

	it("activates SMTP as the selected provider on save", async () => {
		await put(smtpBody({ pass: "s3cret" }));

		const optionsRepo = new OptionsRepository(db);
		expect(await optionsRepo.get<string>(OPTION_KEY)).toBe("emdash-builtin-smtp");
		expect(hooks.setExclusiveSelection).toHaveBeenCalledWith(
			"email:deliver",
			"emdash-builtin-smtp",
		);
	});

	it("selects env-configured SMTP without storing credentials", async () => {
		vi.stubEnv("EMAIL_SMTP_HOST", "smtp.example.com");
		vi.stubEnv("EMAIL_SMTP_USER", "user@example.com");
		vi.stubEnv("EMAIL_SMTP_PASS", "env-secret");
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", "");

		const response = await put({ provider: "smtp" });
		expect(response.status).toBe(200);
		expect(await new OptionsRepository(db).get<string>(OPTION_KEY)).toBe("emdash-builtin-smtp");
		expect(await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY)).toBeNull();
	});

	it("requires SMTP settings when SMTP has no env config", async () => {
		const response = await put({ provider: "smtp" });
		expect(response.status).toBe(400);
		expect(await new OptionsRepository(db).get<string>(OPTION_KEY)).toBeNull();
	});

	it("selects a registered plugin provider", async () => {
		const response = await put({ provider: "plugin", pluginId: "resend" });
		expect(response.status).toBe(200);

		const optionsRepo = new OptionsRepository(db);
		expect(await optionsRepo.get<string>(OPTION_KEY)).toBe("resend");
		expect(hooks.setExclusiveSelection).toHaveBeenCalledWith("email:deliver", "resend");
	});

	it("rejects an unregistered plugin provider", async () => {
		const response = await put({ provider: "plugin", pluginId: "not-installed" });
		expect(response.status).toBe(400);
		const optionsRepo = new OptionsRepository(db);
		expect(await optionsRepo.get<string>(OPTION_KEY)).toBeNull();
	});

	it("rejects the SMTP ID via the plugin variant", async () => {
		const response = await put({ provider: "plugin", pluginId: "emdash-builtin-smtp" });
		expect(response.status).toBe(400);
	});

	it("returns 403 for a user without settings:manage", async () => {
		const response = await putEmailSettings({
			request: new Request("http://localhost/_emdash/api/settings/email", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: "plugin", pluginId: "resend" }),
			}),
			locals: {
				emdash: { db, hooks },
				user: { id: "author-1", role: Role.AUTHOR },
			},
		} as unknown as Parameters<typeof putEmailSettings>[0]);
		expect(response.status).toBe(403);
	});
});
