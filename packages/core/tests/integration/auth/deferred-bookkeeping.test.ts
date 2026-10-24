// workerd can cancel pending work that was not handed to `waitUntil` once the
// response is out. The stand-in `waitUntil` collects what the code under test hands it.
import type { EmailMessage } from "@emdash-cms/auth";
import { Role, sendMagicLink } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { APIContext } from "astro";
import type { Kysely, KyselyPlugin, QueryId } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { handedToWaitUntil } = vi.hoisted(() => ({
	handedToWaitUntil: [] as Promise<unknown>[],
}));

vi.mock("virtual:emdash/wait-until", () => ({
	waitUntil: (promise: Promise<unknown>) => {
		handedToWaitUntil.push(promise);
	},
}));

import { handleApiTokenCreate, resolveApiToken } from "../../../src/api/handlers/api-tokens.js";
import { POST as confirmMagicLink } from "../../../src/astro/routes/api/auth/magic-link/verify.js";
import { POST as passkeyOptions } from "../../../src/astro/routes/api/auth/passkey/options.js";
import { createChallengeStore } from "../../../src/auth/challenge-store.js";
import { checkRateLimit } from "../../../src/auth/rate-limit.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type Db = Kysely<Database>;

const drainTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Holds the result of each query whose SQL matches `write` until `release()` or `fail()`. */
function holdWrites(db: Db, write: RegExp) {
	let release!: () => void;
	let fail!: (error: Error) => void;
	const outcome = new Promise<void>((resolve, reject) => {
		release = resolve;
		fail = reject;
	});
	void outcome.catch(() => {});
	const held = new Set<QueryId>();
	const plugin: KyselyPlugin = {
		transformQuery({ node, queryId }) {
			if (write.test(db.getExecutor().compileQuery(node, queryId).sql)) held.add(queryId);
			return node;
		},
		async transformResult({ queryId, result }) {
			if (held.has(queryId)) await outcome;
			return result;
		},
	};
	return { db: db.withPlugin(plugin), release, fail };
}

function postContext(url: string, db: Db, body: unknown): APIContext {
	const request = new Request(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro-shaped context for the routes under test
	return {
		request,
		url: new URL(url),
		locals: { emdash: { db, config: {} } },
		session: { set: vi.fn() },
	} as unknown as APIContext;
}

interface BookkeepingWrite {
	label: string;
	write: RegExp;
	prepare(db: Db): Promise<(db: Db) => Promise<void>>;
	expectWritten(db: Db): Promise<void>;
}

const twoHoursAgo = () => new Date(Date.now() - 2 * 60 * 60 * 1000);

const writes: BookkeepingWrite[] = [
	{
		label: "the expired magic-link token cleanup",
		write: /^delete from "auth_tokens" where "expires_at" </,
		async prepare(db) {
			const adapter = createKyselyAdapter(db);
			await adapter.createUser({
				email: "author@example.com",
				name: "Author",
				role: Role.AUTHOR,
				emailVerified: true,
			});
			let sent: EmailMessage | undefined;
			await sendMagicLink(
				{
					baseUrl: "https://example.com",
					siteName: "Test",
					email: async (message) => {
						sent = message;
					},
				},
				adapter,
				"author@example.com",
			);
			const token = new URL(sent!.text.match(/https:\/\/\S+/)![0]).searchParams.get("token");
			await adapter.createToken({
				hash: "expired-token-hash",
				email: "author@example.com",
				type: "magic_link",
				expiresAt: twoHoursAgo(),
			});
			return async (held) => {
				const response = await confirmMagicLink(
					postContext("https://example.com/_emdash/api/auth/magic-link/verify", held, { token }),
				);
				expect(response.status).toBe(200);
			};
		},
		async expectWritten(db) {
			const expired = await db
				.selectFrom("auth_tokens")
				.select("hash")
				.where("hash", "=", "expired-token-hash")
				.executeTakeFirst();
			expect(expired).toBeUndefined();
		},
	},
	{
		label: "the expired passkey challenge cleanup",
		write: /^delete from "auth_challenges" where "expires_at" </,
		async prepare(db) {
			await createChallengeStore(db).set("expired-challenge", {
				type: "authentication",
				expiresAt: twoHoursAgo().getTime(),
			});
			return async (held) => {
				const response = await passkeyOptions(
					postContext("https://example.com/_emdash/api/auth/passkey/options", held, {}),
				);
				expect(response.status).toBe(200);
			};
		},
		async expectWritten(db) {
			const expired = await db
				.selectFrom("auth_challenges")
				.select("challenge")
				.where("challenge", "=", "expired-challenge")
				.executeTakeFirst();
			expect(expired).toBeUndefined();
		},
	},
	{
		label: "the sampled rate-limit cleanup",
		write: /DELETE FROM _emdash_rate_limits/,
		async prepare(db) {
			await db
				.insertInto("_emdash_rate_limits")
				.values({
					key: "1.2.3.4:comments/submit",
					window: twoHoursAgo().toISOString(),
					count: 3,
				})
				.execute();
			vi.spyOn(Math, "random").mockReturnValue(0);
			return async (held) => {
				const result = await checkRateLimit(held, "5.6.7.8", "comments/submit", 5, 60);
				expect(result.allowed).toBe(true);
			};
		},
		async expectWritten(db) {
			const keys = await db.selectFrom("_emdash_rate_limits").select("key").execute();
			expect(keys.map((row) => row.key)).toEqual(["5.6.7.8:comments/submit"]);
		},
	},
	{
		label: "the API token last-used update",
		write: /^update "_emdash_api_tokens" set "last_used_at"/,
		async prepare(db) {
			await db
				.insertInto("users")
				.values({ id: "user_1", email: "admin@example.com", role: Role.ADMIN, email_verified: 1 })
				.execute();
			const created = await handleApiTokenCreate(db, "user_1", {
				name: "CI",
				scopes: ["content:read"],
			});
			if (!created.success) throw new Error(created.error.message);
			const rawToken = created.data.token;
			return async (held) => {
				expect(await resolveApiToken(held, rawToken)).not.toBeNull();
			};
		},
		async expectWritten(db) {
			const row = await db
				.selectFrom("_emdash_api_tokens")
				.select("last_used_at")
				.executeTakeFirstOrThrow();
			expect(row.last_used_at).not.toBeNull();
		},
	},
];

describe("bookkeeping writes on request paths", () => {
	let db: Db;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function prepareRun(row: BookkeepingWrite) {
		const run = await row.prepare(db);
		await drainTasks();
		handedToWaitUntil.length = 0;
		return run;
	}

	it.each(writes)("finishes $label before the invocation ends", async (row) => {
		const run = await prepareRun(row);
		const held = holdWrites(db, row.write);

		try {
			await run(held.db);
			await drainTasks();
			const invocationEnded = vi.fn();
			void Promise.allSettled(handedToWaitUntil).then(invocationEnded);
			await drainTasks();
			expect(invocationEnded).not.toHaveBeenCalled();
		} finally {
			held.release();
			await Promise.allSettled(handedToWaitUntil);
		}

		await row.expectWritten(db);
	});

	it.each(writes)("logs a failure of $label", async (row) => {
		const run = await prepareRun(row);
		const held = holdWrites(db, row.write);
		const failure = new Error("write failed");
		held.fail(failure);
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		await run(held.db);
		await drainTasks();
		await Promise.allSettled(handedToWaitUntil);

		expect(errorSpy).toHaveBeenCalledWith(expect.any(String), failure);
	});
});
