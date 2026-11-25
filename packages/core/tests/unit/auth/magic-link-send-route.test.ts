/**
 * POST /_emdash/api/auth/magic-link/send answers the same way whether or not
 * the email has an account. Only an existing account costs a token insert and
 * an email delivery, so the route answers before doing either.
 */

import type { EmailMessage } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as sendLink } from "../../../src/astro/routes/api/auth/magic-link/send.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { runWithContext } from "../../../src/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("magic link send route", () => {
	let db: Kysely<Database>;
	let sentEmails: EmailMessage[];
	let deliver: (message: EmailMessage) => Promise<void>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		sentEmails = [];
		deliver = async (message) => {
			sentEmails.push(message);
		};
		await createKyselyAdapter(db).createUser({
			email: "author@example.com",
			name: "Author",
			role: Role.AUTHOR,
			emailVerified: true,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	let hostWaitUntil: ((promise: Promise<unknown>) => void) | undefined;

	function send(email: string) {
		const request = new Request("https://example.com/_emdash/api/auth/magic-link/send", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email }),
		});
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro-shaped context for the route under test
		const context = {
			request,
			locals: {
				emdash: {
					db,
					config: { siteUrl: "https://example.com" },
					email: {
						isAvailable: () => true,
						send: (message: EmailMessage) => deliver(message),
					},
				},
			},
		} as unknown as APIContext;
		if (!hostWaitUntil) return sendLink(context);
		return runWithContext({ editMode: false, hostWaitUntil: () => hostWaitUntil }, () =>
			sendLink(context),
		);
	}

	async function tokenCount(): Promise<number> {
		const rows = await db.selectFrom("auth_tokens").select("hash").execute();
		return rows.length;
	}

	describe("when the host can run work after the response", () => {
		beforeEach(() => {
			hostWaitUntil = vi.fn();
		});

		afterEach(() => {
			hostWaitUntil = undefined;
		});

		it("answers a known email before creating the token or sending the email", async () => {
			const response = await send("author@example.com");

			expect(response.status).toBe(200);
			expect(sentEmails).toHaveLength(0);
			expect(await tokenCount()).toBe(0);

			await waitForDeferredTasks();
			expect(await tokenCount()).toBe(1);
			expect(sentEmails.map((message) => message.to)).toEqual(["author@example.com"]);
		});

		it("answers an unknown email with the same body and sends nothing", async () => {
			const known = await send("author@example.com");
			const unknown = await send("nobody@example.com");

			expect(unknown.status).toBe(known.status);
			expect(await unknown.text()).toBe(await known.text());

			await waitForDeferredTasks();
			expect(await tokenCount()).toBe(1);
			expect(sentEmails.map((message) => message.to)).toEqual(["author@example.com"]);
		});

		it("logs a delivery failure", async () => {
			const failure = new Error("provider unavailable");
			deliver = () => Promise.reject(failure);
			const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

			const response = await send("author@example.com");
			expect(response.status).toBe(200);

			await waitForDeferredTasks();
			expect(errorSpy).toHaveBeenCalledWith("Magic link send error:", failure);
		});
	});

	describe("when the host may stop after the response", () => {
		it("sends to a known email before answering", async () => {
			const response = await send("author@example.com");

			expect(response.status).toBe(200);
			expect(await tokenCount()).toBe(1);
			expect(sentEmails.map((message) => message.to)).toEqual(["author@example.com"]);
		});

		it("pauses before answering an unknown email", async () => {
			const started = performance.now();
			const response = await send("nobody@example.com");

			expect(response.status).toBe(200);
			expect(performance.now() - started).toBeGreaterThanOrEqual(95);
			expect(sentEmails).toHaveLength(0);
		});
	});
});
