import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { recordLogin as recordAtprotoLogin } from "../../../../auth-atproto/src/record-login.js";
import { startUserSession } from "../../../src/auth/start-user-session.js";
import * as migration from "../../../src/database/migrations/098_user_last_login.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("user last login", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		db = ctx.db;
	});

	afterEach(async () => {
		vi.useRealTimers();
		await teardownForDialect(ctx);
	});

	it("returns null before a user has logged in", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "new@example.com", role: Role.AUTHOR });

		expect(
			(await adapter.getUsers()).items.find((item) => item.id === user.id)?.lastLogin,
		).toBeNull();
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toBeNull();
	});

	it("records each session start and exposes it in list and detail", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "login@example.com", role: Role.ADMIN });
		const session = { set: vi.fn() };
		const first = new Date("2025-01-01T00:00:00.000Z");
		vi.setSystemTime(first);

		await startUserSession(db, session, user.id);
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toEqual(first);
		expect((await adapter.getUsers()).items.find((item) => item.id === user.id)?.lastLogin).toEqual(
			first,
		);

		const second = new Date("2025-01-02T00:00:00.000Z");
		vi.setSystemTime(second);
		await startUserSession(db, session, user.id);
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toEqual(second);
		expect(session.set).toHaveBeenLastCalledWith("user", { id: user.id });
	});

	it("preserves legacy passkey history and prefers the recorded login", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "passkey@example.com", role: Role.AUTHOR });
		await adapter.createCredential({
			id: "credential-old",
			userId: user.id,
			publicKey: new Uint8Array([1]),
			algorithm: -7,
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
			transports: ["internal"],
			name: "Old",
		});
		await adapter.createCredential({
			id: "credential-new",
			userId: user.id,
			publicKey: new Uint8Array([2]),
			algorithm: -7,
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
			transports: ["internal"],
			name: "New",
		});
		await db
			.updateTable("credentials")
			.set({ last_used_at: "2025-01-02T00:00:00.000Z" })
			.where("id", "=", "credential-old")
			.execute();
		await db
			.updateTable("credentials")
			.set({ last_used_at: "2025-01-03T00:00:00.000Z" })
			.where("id", "=", "credential-new")
			.execute();

		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toEqual(
			new Date("2025-01-03T00:00:00.000Z"),
		);
		expect((await adapter.getUsers()).items.find((item) => item.id === user.id)?.lastLogin).toEqual(
			new Date("2025-01-03T00:00:00.000Z"),
		);

		await db
			.updateTable("users")
			.set({ last_login_at: "2025-01-01T00:00:00.000Z" })
			.where("id", "=", user.id)
			.execute();
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toEqual(
			new Date("2025-01-01T00:00:00.000Z"),
		);
		expect((await adapter.getUsers()).items.find((item) => item.id === user.id)?.lastLogin).toEqual(
			new Date("2025-01-01T00:00:00.000Z"),
		);
	});

	it("does not change profile timestamps or another user when starting a session", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "one@example.com", role: Role.AUTHOR });
		const other = await adapter.createUser({ email: "two@example.com", role: Role.AUTHOR });
		const before = await db
			.selectFrom("users")
			.select(["updated_at"])
			.where("id", "in", [user.id, other.id])
			.orderBy("id")
			.execute();

		await startUserSession(db, { set: vi.fn() }, user.id);

		const after = await db
			.selectFrom("users")
			.select(["id", "updated_at", "last_login_at"])
			.where("id", "in", [user.id, other.id])
			.orderBy("id")
			.execute();
		expect(after.map(({ updated_at }) => updated_at)).toEqual(
			before.map(({ updated_at }) => updated_at),
		);
		expect(after.find((row) => row.id === user.id)?.last_login_at).toEqual(expect.any(String));
		expect(after.find((row) => row.id === other.id)?.last_login_at).toBeNull();
	});

	it("records AT Protocol logins but tolerates a provider upgrade ahead of core", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "atproto@example.com" });
		await recordAtprotoLogin(db, user.id);
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toBeInstanceOf(Date);
		await db.schema.alterTable("users").dropColumn("last_login_at").execute();
		await expect(recordAtprotoLogin(db, user.id)).resolves.toBeUndefined();
		expect(
			(await adapter.getUsers()).items.find((item) => item.id === user.id)?.lastLogin,
		).toBeNull();
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toBeNull();
	});

	it("retains standalone adapter passkey history without the new column", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "standalone@example.com" });
		const credential = await adapter.createCredential({
			id: "standalone-credential",
			userId: user.id,
			publicKey: new Uint8Array([1]),
			algorithm: -7,
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
			transports: ["internal"],
		});
		await db.schema.alterTable("users").dropColumn("last_login_at").execute();
		expect((await adapter.getUsers()).items.find((item) => item.id === user.id)?.lastLogin).toEqual(
			credential.lastUsedAt,
		);
		expect((await adapter.getUserWithDetails(user.id))?.lastLogin).toEqual(credential.lastUsedAt);
	});

	it("does not establish a session if recording the login fails", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "failure@example.com" });
		await db.schema.alterTable("users").dropColumn("last_login_at").execute();
		const session = { set: vi.fn() };
		await expect(startUserSession(db, session, user.id)).rejects.toThrow();
		expect(session.set).not.toHaveBeenCalled();
	});

	it("adds the column idempotently when upgrading an existing database", async () => {
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({ email: "upgrade@example.com", role: Role.AUTHOR });
		await db.schema.alterTable("users").dropColumn("last_login_at").execute();

		await migration.up(db);
		await migration.up(db);

		const row = await db
			.selectFrom("users")
			.selectAll()
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		expect(row.email).toBe("upgrade@example.com");
		expect(row.last_login_at).toBeNull();
		await db
			.updateTable("users")
			.set({ last_login_at: "2025-02-01T00:00:00.000Z" })
			.where("id", "=", user.id)
			.execute();
		expect(
			(
				await db
					.selectFrom("users")
					.select("last_login_at")
					.where("id", "=", user.id)
					.executeTakeFirstOrThrow()
			).last_login_at,
		).toBe("2025-02-01T00:00:00.000Z");
	});
});
