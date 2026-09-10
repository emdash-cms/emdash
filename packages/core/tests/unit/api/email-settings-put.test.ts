import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { PUT as putEmailSettings } from "../../../src/astro/routes/api/settings/email.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { loadSmtpConfigFromDb } from "../../../src/plugins/email-smtp.js";
import { EXCLUSIVE_HOOK_NONE_VALUE } from "../../../src/plugins/hooks.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const TEST_ENCRYPTION_KEY = "emdash_enc_v1_U-1To8mS9tyTfAFz8KHAsCVo1fvktqbq0y5JxBiXgIU";
const OPTION_KEY = "emdash:exclusive_hook:email:deliver";

describe("PUT /_emdash/api/settings/email", () => {
	let db: Kysely<Database>;
	let hooks: {
		getExclusiveHookProviders: ReturnType<typeof vi.fn>;
		setExclusiveSelection: ReturnType<typeof vi.fn>;
		clearExclusiveSelection: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		db = await setupTestDatabase();
		hooks = {
			getExclusiveHookProviders: vi.fn().mockReturnValue([
				{ pluginId: "emdash-smtp", autoSelect: false },
				{ pluginId: "resend", autoSelect: true },
			]),
			setExclusiveSelection: vi.fn(),
			clearExclusiveSelection: vi.fn(),
		};
		process.env.EMDASH_ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		delete process.env.EMDASH_ENCRYPTION_KEY;
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

	it("keeps the stored password when a later save omits it", async () => {
		const first = await put(smtpBody({ pass: "s3cret" }));
		expect(first.status).toBe(200);

		const second = await put(smtpBody({ host: "smtp2.example.com" }));
		expect(second.status).toBe(200);

		const stored = await loadSmtpConfigFromDb(db, TEST_ENCRYPTION_KEY);
		expect(stored?.host).toBe("smtp2.example.com");
		expect(stored?.pass).toBe("s3cret");
	});

	it("activates SMTP as the selected provider on save", async () => {
		await put(smtpBody({ pass: "s3cret" }));

		const optionsRepo = new OptionsRepository(db);
		expect(await optionsRepo.get<string>(OPTION_KEY)).toBe("emdash-smtp");
		expect(hooks.setExclusiveSelection).toHaveBeenCalledWith("email:deliver", "emdash-smtp");
	});

	it("stores the none-sentinel and clears the in-memory selection", async () => {
		const response = await put({ provider: "none" });
		expect(response.status).toBe(200);

		const optionsRepo = new OptionsRepository(db);
		expect(await optionsRepo.get<string>(OPTION_KEY)).toBe(EXCLUSIVE_HOOK_NONE_VALUE);
		expect(hooks.clearExclusiveSelection).toHaveBeenCalledWith("email:deliver");
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

	it("rejects built-in IDs via the plugin variant", async () => {
		const response = await put({ provider: "plugin", pluginId: "emdash-smtp" });
		expect(response.status).toBe(400);
	});

	it("returns 403 for a user without settings:manage", async () => {
		const response = await putEmailSettings({
			request: new Request("http://localhost/_emdash/api/settings/email", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ provider: "none" }),
			}),
			locals: {
				emdash: { db, hooks },
				user: { id: "author-1", role: Role.AUTHOR },
			},
		} as unknown as Parameters<typeof putEmailSettings>[0]);
		expect(response.status).toBe(403);
	});
});
