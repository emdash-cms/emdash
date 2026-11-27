import type { EmailMessage } from "@emdash-cms/auth";
import { Role, hashToken, requestSignup, validateSignupToken } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { POST as signupRegisterOptions } from "../../../src/astro/routes/api/auth/signup/register-options.js";
import type { Database } from "../../../src/database/types.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const TOKEN_EXTRACT_REGEX = /token=([a-zA-Z0-9_-]+)/;
const ENDPOINT = "http://localhost:4321/_emdash/api/auth/signup/register-options";

describeEachDialect("POST /auth/signup/register-options", (dialect) => {
	let dbContext: DialectTestContext;
	let db: Kysely<Database>;
	let token: string;

	beforeEach(async () => {
		dbContext = await setupForDialect(dialect);
		db = dbContext.db;
		const adapter = createKyselyAdapter(db);

		await adapter.createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		await adapter.createAllowedDomain("example.com", Role.SUBSCRIBER);

		let message: EmailMessage | undefined;
		await requestSignup(
			{
				baseUrl: "https://example.com/_emdash",
				siteName: "Test Site",
				email: async (sent) => {
					message = sent;
				},
			},
			adapter,
			"newuser@example.com",
		);
		const match = message?.text.match(TOKEN_EXTRACT_REGEX);
		if (!match?.[1]) throw new Error("signup token was not sent");
		token = match[1];
	});

	afterEach(async () => {
		await teardownForDialect(dbContext);
	});

	function request(body: unknown): Request {
		return new Request(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
	}

	function context(req: Request = request({ token })): Parameters<typeof signupRegisterOptions>[0] {
		return {
			request: req,
			locals: { emdash: { db, config: { siteUrl: "https://public.example.com" } } },
		} as Parameters<typeof signupRegisterOptions>[0];
	}

	it("generates options for an email-verified token without consuming it or requiring setup", async () => {
		const response = await signupRegisterOptions(context());

		expect(response.status).toBe(200);
		const body = (await response.json()) as {
			success: boolean;
			data: {
				options: {
					challenge: string;
					rp: { id: string };
					user: { name: string; displayName: string };
				};
			};
		};
		expect(body.success).toBe(true);
		expect(body.data.options.user.name).toBe("newuser@example.com");
		expect(body.data.options.rp.id).toBe("public.example.com");

		const challenge = await db
			.selectFrom("auth_challenges")
			.selectAll()
			.where("challenge", "=", body.data.options.challenge)
			.executeTakeFirst();
		expect(challenge).toMatchObject({ type: "registration" });

		const validated = await validateSignupToken(createKyselyAdapter(db), token);
		expect(validated.email).toBe("newuser@example.com");
	});

	it.each([
		["missing token", {}, "VALIDATION_ERROR"],
		["empty token", { token: "" }, "VALIDATION_ERROR"],
		["malformed body", { token: 123 }, "VALIDATION_ERROR"],
	] as const)("rejects %s before creating a challenge", async (_label, body, code) => {
		const response = await signupRegisterOptions(context(request(body)));

		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ error: { code } });
		expect(await db.selectFrom("auth_challenges").selectAll().execute()).toHaveLength(0);
	});

	it("returns 404 for an invalid token without creating a challenge", async () => {
		const response = await signupRegisterOptions(context(request({ token: "not-a-token" })));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
		expect(await db.selectFrom("auth_challenges").selectAll().execute()).toHaveLength(0);
	});

	it("returns 410 for an expired signup token without creating a challenge", async () => {
		await db
			.updateTable("auth_tokens")
			.set({ expires_at: new Date(Date.now() - 60_000).toISOString() })
			.where("hash", "=", hashToken(token))
			.execute();

		const response = await signupRegisterOptions(context());

		expect(response.status).toBe(410);
		expect(await response.json()).toMatchObject({ error: { code: "TOKEN_EXPIRED" } });
		expect(await db.selectFrom("auth_challenges").selectAll().execute()).toHaveLength(0);
	});

	it("does not use a token of the wrong type", async () => {
		const wrongTypeToken = "wrong-type-token";
		await db
			.insertInto("auth_tokens")
			.values({
				hash: hashToken(wrongTypeToken),
				email: "wrong@example.com",
				type: "invite",
				role: Role.SUBSCRIBER,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();

		const response = await signupRegisterOptions(context(request({ token: wrongTypeToken })));

		expect(response.status).toBe(404);
		expect(await response.json()).toMatchObject({ error: { code: "INVALID_TOKEN" } });
		expect(await db.selectFrom("auth_challenges").selectAll().execute()).toHaveLength(0);
	});

	it("returns 500 when EmDash is not initialized", async () => {
		const response = await signupRegisterOptions({
			request: request({ token }),
			locals: { emdash: undefined },
		} as Parameters<typeof signupRegisterOptions>[0]);

		expect(response.status).toBe(500);
		expect(await response.json()).toMatchObject({ error: { code: "NOT_CONFIGURED" } });
	});
});
