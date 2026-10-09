import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/settings/email.js";
import type { Database } from "../../../src/database/types.js";
import {
	SMTP_EMAIL_PLUGIN_ID,
	SmtpDeliveryError,
	saveSmtpConfigToDb,
} from "../../../src/plugins/email-smtp.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const TEST_ENCRYPTION_KEY = "emdash_enc_v1_U-1To8mS9tyTfAFz8KHAsCVo1fvktqbq0y5JxBiXgIU";

describe("email settings GET and POST", () => {
	let db: Kysely<Database>;
	let inMemorySelection: string | undefined;
	let send: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		inMemorySelection = undefined;
		send = vi.fn();
		vi.stubEnv("EMDASH_ENCRYPTION_KEY", TEST_ENCRYPTION_KEY);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	const locals = () => ({
		emdash: {
			db,
			hooks: {
				getExclusiveHookProviders: () => [{ pluginId: SMTP_EMAIL_PLUGIN_ID }],
				getHookProviders: () => [],
				getExclusiveSelection: () => inMemorySelection,
			},
			email: { isAvailable: () => true, send },
		},
		user: { id: "admin-1", role: Role.ADMIN },
	});

	const get = async () => {
		const response = await GET({
			locals: locals(),
		} as unknown as Parameters<typeof GET>[0]);
		return (await response.json()) as { data: Record<string, any> };
	};

	const stubSmtpEnv = () => {
		vi.stubEnv("EMAIL_SMTP_HOST", "env.example.com");
		vi.stubEnv("EMAIL_SMTP_USER", "env@example.com");
		vi.stubEnv("EMAIL_SMTP_PASS", "env-secret");
	};

	it("reports env-configured SMTP selected in memory only", async () => {
		stubSmtpEnv();
		inMemorySelection = SMTP_EMAIL_PLUGIN_ID;

		const { data } = await get();

		expect(data.selectedProviderId).toBe(SMTP_EMAIL_PLUGIN_ID);
		expect(data.smtp).toMatchObject({ configured: true, source: "env", host: "env.example.com" });
	});

	it("reports saved SMTP settings even when the env config is invalid", async () => {
		vi.stubEnv("EMAIL_SMTP_HOST", "env.example.com");
		await saveSmtpConfigToDb(db, TEST_ENCRYPTION_KEY, {
			host: "db.example.com",
			port: 465,
			secure: "tls",
			user: "db@example.com",
			pass: "db-secret",
		});

		const { data } = await get();

		expect(data.smtp).toMatchObject({ configured: true, source: "db", host: "db.example.com" });
	});

	it("returns SMTP delivery errors from a test send as 502", async () => {
		send.mockRejectedValue(new SmtpDeliveryError("Authentication failed (535 nope)"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		const response = await POST({
			request: new Request("http://localhost/_emdash/api/settings/email", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ to: "admin@example.com" }),
			}),
			locals: locals(),
		} as unknown as Parameters<typeof POST>[0]);

		expect(response.status).toBe(502);
		await expect(response.json()).resolves.toMatchObject({
			error: { message: expect.stringContaining("Authentication failed (535 nope)") },
		});
	});
});
