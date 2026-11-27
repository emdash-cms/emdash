import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import * as migration100 from "../../../src/database/migrations/100_verify_setup_owner_email.js";
import { createMigrator } from "../../../src/database/migrations/runner.js";
import {
	createForDialect,
	describeEachDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("verify setup owner email migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await createForDialect(dialect);
		const { error } = await createMigrator(ctx.db, {
			migrationTableSchema: ctx.pgCtx?.schemaName,
		}).migrateTo("099_editorial_comments");
		if (error) throw error;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function addUser(
		email: string,
		createdAt: string,
		options: { role?: number; passkey?: boolean; provider?: boolean } = {},
	) {
		const adapter = createKyselyAdapter(ctx.db);
		const user = await adapter.createUser({
			email,
			name: null,
			role: options.role ?? Role.ADMIN,
			emailVerified: false,
		});
		await sql`UPDATE users SET created_at = ${createdAt} WHERE id = ${user.id}`.execute(ctx.db);
		if (options.passkey ?? true) {
			await adapter.createCredential({
				id: `cred-${user.id}`,
				userId: user.id,
				publicKey: new Uint8Array([1, 2, 3]),
				algorithm: -7,
				counter: 0,
				deviceType: "multiDevice",
				backedUp: true,
				transports: [],
			});
		}
		if (options.provider) {
			await adapter.createOAuthAccount({
				provider: "github",
				providerAccountId: `gh-${user.id}`,
				userId: user.id,
			});
		}
		return user.id;
	}

	async function verifiedEmails() {
		const rows = await sql<{ email: string }>`
			SELECT email FROM users WHERE email_verified = 1 ORDER BY email
		`.execute(ctx.db);
		return rows.rows.map((row) => row.email);
	}

	it("verifies only the first user when it is a passkey admin, and can restart", async () => {
		await addUser("owner@example.com", "2025-01-01T00:00:00.000Z");
		await addUser("second-admin@example.com", "2025-02-01T00:00:00.000Z");

		await migration100.up(ctx.db);
		await migration100.up(ctx.db);

		expect(await verifiedEmails()).toEqual(["owner@example.com"]);
	});

	it("leaves an owner who has a linked provider account unverified", async () => {
		await addUser("owner@example.com", "2025-01-01T00:00:00.000Z", { provider: true });

		await migration100.up(ctx.db);

		expect(await verifiedEmails()).toEqual([]);
	});

	it("leaves an owner without a passkey unverified", async () => {
		await addUser("owner@example.com", "2025-01-01T00:00:00.000Z", { passkey: false });

		await migration100.up(ctx.db);

		expect(await verifiedEmails()).toEqual([]);
	});

	it("leaves the first user unverified when it is no longer an admin", async () => {
		await addUser("owner@example.com", "2025-01-01T00:00:00.000Z", { role: Role.EDITOR });
		await addUser("admin@example.com", "2025-02-01T00:00:00.000Z");

		await migration100.up(ctx.db);

		expect(await verifiedEmails()).toEqual([]);
	});

	it("leaves an AT Protocol placeholder address unverified", async () => {
		await addUser("did-plc-abc@atproto.invalid", "2025-01-01T00:00:00.000Z");

		await migration100.up(ctx.db);

		expect(await verifiedEmails()).toEqual([]);
	});
});
