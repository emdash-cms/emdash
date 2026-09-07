import { CompiledQuery, Kysely, sql } from "kysely";
import { describe, expect, it, vi } from "vitest";

import { D1AmbiguousWriteError, D1RestDialect } from "../../src/db/d1-rest-dialect.js";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";
const DATABASE_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "cloudflare-secret-token";

function queryEnvelope(
	results: Array<Record<string, unknown>> = [],
	meta: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		success: true,
		errors: [],
		messages: [],
		result: [
			{
				success: true,
				results,
				meta: {
					changed_db: false,
					changes: 0,
					duration: 0.1,
					last_row_id: 0,
					rows_read: results.length,
					rows_written: 0,
					size_after: 4096,
					...meta,
				},
			},
		],
	};
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("content-type", "application/json");
	return Response.json(body, {
		...init,
		headers,
	});
}

function database(
	fetch: typeof globalThis.fetch,
	options: { timeoutMs?: number; maxResponseBytes?: number } = {},
) {
	return new Kysely<Record<string, never>>({
		dialect: new D1RestDialect({
			accountId: ACCOUNT_ID,
			databaseId: DATABASE_ID,
			token: TOKEN,
			fetch,
			...options,
		}),
	});
}

describe("D1RestDialect", () => {
	it("sends one compiled query with ordered normalized parameters", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			expect(init?.method).toBe("POST");
			expect(init?.redirect).toBe("error");
			expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
			if (typeof init?.body !== "string") throw new Error("Expected a JSON request body.");
			expect(JSON.parse(init.body)).toEqual({
				sql: "select ?, ?, ?, ?",
				params: ["text", 42, null, 1],
			});
			return jsonResponse(queryEnvelope([{ value: "ok" }]));
		});
		const db = database(fetch);

		await expect(
			sql<{ value: string }>`select ${"text"}, ${42}, ${null}, ${true}`.execute(db),
		).resolves.toMatchObject({ rows: [{ value: "ok" }] });
		expect(fetch).toHaveBeenCalledTimes(1);
		await db.destroy();
	});

	it.each([
		[Number.NaN],
		[Number.POSITIVE_INFINITY],
		[Number.MAX_SAFE_INTEGER + 1],
		[123n],
		[{ unsafe: true }],
	])("rejects an unsupported parameter before sending it", async (parameter) => {
		const fetch = vi.fn<typeof globalThis.fetch>();
		const db = database(fetch);

		await expect(sql`select ${parameter}`.execute(db)).rejects.toThrow(/parameter/i);
		expect(fetch).not.toHaveBeenCalled();
		await db.destroy();
	});

	it("rejects a non-success HTTP status", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse(
				{
					success: false,
					errors: [{ code: 9109, message: "Unauthorized" }],
					messages: [],
					result: null,
				},
				{ status: 401 },
			),
		);
		const db = database(fetch);

		await expect(sql`select 1`.execute(db)).rejects.toThrow(/HTTP status 401/i);
		expect(fetch).toHaveBeenCalledTimes(1);
		await db.destroy();
	});

	it("preserves a top-level Cloudflare API failure", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({
				success: false,
				errors: [{ code: 7500, message: "D1 API unavailable" }],
				messages: [],
				result: null,
			}),
		);
		const db = database(fetch);

		await expect(sql`select 1`.execute(db)).rejects.toThrow(/D1 API unavailable/);
		await db.destroy();
	});

	it("maps validated affected-row and insert metadata", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse(
				queryEnvelope([], {
					changed_db: true,
					changes: 2,
					last_row_id: 17,
					rows_written: 2,
				}),
			),
		);
		const db = database(fetch);

		await expect(sql`insert into example values (1)`.execute(db)).resolves.toMatchObject({
			insertId: 17n,
			numAffectedRows: 2n,
		});
		await db.destroy();
	});

	it.each([
		["non-JSON content", new Response("not json", { headers: { "content-type": "text/plain" } })],
		["malformed envelope", jsonResponse({ success: true, result: [] })],
		["multiple statement results", jsonResponse({ ...queryEnvelope(), result: [{}, {}] })],
		["invalid metadata", jsonResponse(queryEnvelope([], { changes: -1 }))],
	])("rejects a %s", async (_name, response) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
		const db = database(fetch);

		await expect(sql`select 1`.execute(db)).rejects.toThrow(/D1/i);
		await db.destroy();
	});

	it("rejects a declared response larger than the bound", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response("{}", {
					headers: {
						"content-length": "1000",
						"content-type": "application/json",
					},
				}),
		);
		const db = database(fetch, { maxResponseBytes: 100 });

		await expect(sql`select 1`.execute(db)).rejects.toThrow(/response.*large/i);
		await db.destroy();
	});

	it("rejects a streamed response larger than the bound", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(new Uint8Array(60));
							controller.enqueue(new Uint8Array(60));
							controller.close();
						},
					}),
					{ headers: { "content-type": "application/json" } },
				),
		);
		const db = database(fetch, { maxResponseBytes: 100 });

		await expect(sql`select 1`.execute(db)).rejects.toThrow(/response.*large/i);
		await db.destroy();
	});

	it("preserves a statement error needed for duplicate-record recovery", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({
				...queryEnvelope(),
				result: [
					{
						success: false,
						error: "UNIQUE constraint failed: _emdash_migrations.name",
						results: [],
						meta: queryEnvelope().result,
					},
				],
			}),
		);
		const db = database(fetch);

		await expect(sql`insert into _emdash_migrations values (1)`.execute(db)).rejects.toThrow(
			"UNIQUE constraint failed: _emdash_migrations.name",
		);
		await db.destroy();
	});

	it("bounds and sanitizes upstream error messages", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({
				success: false,
				errors: [
					{
						code: 10_000,
						message: `before\t${TOKEN}\n${"x".repeat(2_000)}`,
					},
				],
				messages: [],
				result: [],
			}),
		);
		const db = database(fetch);

		let error: unknown;
		try {
			await sql`select 1`.execute(db);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("before [redacted] ");
		expect((error as Error).message).not.toContain(TOKEN);
		expect((error as Error).message).not.toMatch(/[\r\n\t]/);
		expect((error as Error).message.length).toBeLessThanOrEqual(
			"D1 API request failed: ".length + 1_000,
		);
		await db.destroy();
	});

	it("does not retry an ambiguous write failure and never leaks the token", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new TypeError(`network failed near ${TOKEN}`);
		});
		const db = database(fetch);

		let error: unknown;
		try {
			await sql`create table example (id integer)`.execute(db);
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(D1AmbiguousWriteError);
		expect((error as Error).message).toMatch(/ambiguous.*--status/i);
		expect((error as Error).message).not.toContain(TOKEN);
		expect(fetch).toHaveBeenCalledTimes(1);
		await db.destroy();
	});

	it.each([
		["malformed", jsonResponse({ success: true, result: [] })],
		[
			"oversized",
			new Response("{}", {
				headers: {
					"content-length": "1000",
					"content-type": "application/json",
				},
			}),
		],
	])("classifies a %s successful write response as ambiguous", async (_name, response) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response);
		const db = database(fetch, { maxResponseBytes: 100 });

		await expect(sql`create table example (id integer)`.execute(db)).rejects.toBeInstanceOf(
			D1AmbiguousWriteError,
		);
		expect(fetch).toHaveBeenCalledTimes(1);
		await db.destroy();
	});

	it("keeps an explicit statement failure definitive", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({
				...queryEnvelope(),
				result: [{ success: false, error: "syntax error", results: [] }],
			}),
		);
		const db = database(fetch);

		let error: unknown;
		try {
			await sql`create table example (id integer`.execute(db);
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(Error);
		expect(error).not.toBeInstanceOf(D1AmbiguousWriteError);
		expect((error as Error).message).toContain("syntax error");
		await db.destroy();
	});

	it("aborts a timed-out request", async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		const db = database(fetch, { timeoutMs: 5 });

		await expect(sql`select 1`.execute(db)).rejects.toThrow(/timed out/i);
		expect(fetch).toHaveBeenCalledTimes(1);
		await db.destroy();
	});

	it("aborts an active request when the driver is destroyed", async () => {
		let signal: AbortSignal | undefined;
		const fetch = vi.fn<typeof globalThis.fetch>(
			(_input, init) =>
				new Promise((_resolve, reject) => {
					signal = init?.signal ?? undefined;
					init?.signal?.addEventListener("abort", () =>
						reject(new DOMException("Aborted", "AbortError")),
					);
				}),
		);
		const dialect = new D1RestDialect({
			accountId: ACCOUNT_ID,
			databaseId: DATABASE_ID,
			token: TOKEN,
			fetch,
		});
		const driver = dialect.createDriver();
		await driver.init();
		const connection = await driver.acquireConnection();
		const query = connection.executeQuery(CompiledQuery.raw("select 1"));
		await vi.waitFor(() => expect(signal).toBeDefined());

		await driver.destroy();
		await expect(query).rejects.toThrow(/valid response/i);
		expect(signal?.aborted).toBe(true);
	});
});
