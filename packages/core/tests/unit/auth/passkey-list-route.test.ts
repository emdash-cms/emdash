import type { User } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { generateRegistrationOptions } from "@emdash-cms/auth/passkey";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetEnvCache } from "../../../src/api/public-url.js";
import { GET as listPasskeys } from "../../../src/astro/routes/api/auth/passkey/index.js";
import { getPasskeyConfig } from "../../../src/auth/passkey-config.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const SITE_URL = "https://cms.example.com";

describe("passkey list route", () => {
	let db: Kysely<Database>;
	let user: User;

	beforeEach(async () => {
		db = await setupTestDatabase();
		_resetEnvCache();
		const adapter = createKyselyAdapter(db);
		user = await adapter.createUser({
			email: "editor@example.com",
			name: "Editor",
			role: Role.EDITOR,
		});
		await adapter.createCredential({
			id: "credential-1",
			userId: user.id,
			publicKey: new Uint8Array([1, 2, 3, 4]),
			algorithm: -7,
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
			transports: ["internal"],
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("identifies the passkeys with the relying party and user handle used to register them", async () => {
		const response = await listPasskeys({
			request: new Request("http://localhost:4321/_emdash/api/auth/passkey"),
			locals: { emdash: { db, config: { siteUrl: SITE_URL } }, user },
		} as unknown as Parameters<typeof listPasskeys>[0]);

		const registration = await generateRegistrationOptions(
			getPasskeyConfig(new URL("http://localhost:4321/"), undefined, SITE_URL),
			user,
			[],
			{ set: vi.fn(async () => undefined) },
		);

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			data: { items: Array<{ id: string }>; rpId: string; userHandle: string };
		};
		expect(body.data.items.map((passkey) => passkey.id)).toEqual(["credential-1"]);
		expect(body.data.rpId).toBe(registration.rp.id);
		expect(body.data.userHandle).toBe(registration.user.id);
	});
});
