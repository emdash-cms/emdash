import type { EmailMessage, EmailSendFn } from "@emdash-cms/auth";
import { Role, createInvite } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { _resetEnvCache } from "../../../src/api/public-url.js";
import { POST as inviteRegisterOptions } from "../../../src/astro/routes/api/auth/invite/register-options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const TOKEN_EXTRACT_REGEX = /token=([a-zA-Z0-9_-]+)/;

/**
 * Issue #994: when EmDash runs behind a TLS-terminating reverse proxy
 * (Traefik, nginx, etc.) the request URL Astro sees is the internal
 * upstream — typically `http://localhost:4321` — while the browser is on
 * `https://staging.example.com`. The invite passkey register-options
 * endpoint used to call `getPasskeyConfig(url, siteName)` without the
 * resolved siteUrl, so the WebAuthn RP ID came back as `localhost` and the
 * browser rejected the registration with "Security error".
 *
 * Every other passkey endpoint already resolves `siteUrl` via
 * `getPublicOrigin(url, emdash.config)` before calling `getPasskeyConfig`.
 * This regression test pins the invite/register-options route to the same
 * behavior so the bug can't quietly come back.
 */
describe("invite register-options route — siteUrl resolution (issue #994)", () => {
	let db: Kysely<Database>;
	let adminId: string;
	let inviteToken: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		_resetEnvCache();

		const adapter = createKyselyAdapter(db);

		// Create an admin user (required for the invitedBy FK on the invite).
		const admin = await adapter.createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		adminId = admin.id;

		// Create an invite and capture the raw token from the email body.
		let captured: string | null = null;
		const mockSend: EmailSendFn = vi.fn(async (msg: EmailMessage) => {
			const match = msg.text.match(TOKEN_EXTRACT_REGEX);
			captured = match ? (match[1] ?? null) : null;
		});

		await createInvite(
			{ baseUrl: "https://staging.example.com", siteName: "Test", email: mockSend },
			adapter,
			"newuser@example.com",
			Role.AUTHOR,
			adminId,
		);

		if (!captured) throw new Error("failed to capture invite token");
		inviteToken = captured;
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		_resetEnvCache();
	});

	it("uses the public siteUrl from config for the passkey RP, not the internal hostname", async () => {
		// Internal request URL — what Astro sees behind the reverse proxy.
		const request = new Request("http://localhost:4321/_emdash/api/auth/invite/register-options", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: inviteToken, name: "New User" }),
		});

		const response = await inviteRegisterOptions({
			request,
			locals: {
				emdash: {
					db,
					// Browser-facing origin set in the EmDash config (or via
					// EMDASH_SITE_URL — resolved here through getPublicOrigin).
					config: { siteUrl: "https://staging.example.com" },
				},
			},
		} as Parameters<typeof inviteRegisterOptions>[0]);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { options: { rp: { id: string; name: string } } };
		};

		// The bug: rp.id was "localhost" (url.hostname). With the fix, rp.id
		// reflects the configured public origin's hostname.
		expect(body.data.options.rp.id).toBe("staging.example.com");
		expect(body.data.options.rp.id).not.toBe("localhost");
	});

	it("falls back to the request hostname when no siteUrl is configured", async () => {
		// No config.siteUrl and no env var — the request URL is the only signal
		// available, so `rp.id` should match `url.hostname`. This guards against
		// a regression where the fix accidentally hard-codes a value or breaks
		// the single-host / dev case.
		const request = new Request("http://localhost:4321/_emdash/api/auth/invite/register-options", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token: inviteToken }),
		});

		const response = await inviteRegisterOptions({
			request,
			locals: {
				emdash: {
					db,
					config: {},
				},
			},
		} as Parameters<typeof inviteRegisterOptions>[0]);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { options: { rp: { id: string } } };
		};
		expect(body.data.options.rp.id).toBe("localhost");
	});
});
