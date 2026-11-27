import { Kysely, sql } from "kysely";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { clients } = vi.hoisted(() => ({
	clients: [] as Array<{
		connectionString: string;
		queries: string[];
		ended: boolean;
	}>,
}));

vi.mock("cloudflare:workers", () => ({
	env: { HYPERDRIVE: { connectionString: "postgres://primary/uncached" } },
	waitUntil: (_p: Promise<unknown>) => {},
}));

vi.mock("pg", () => {
	class Client {
		readonly state;
		constructor(opts: { connectionString: string }) {
			this.state = {
				connectionString: opts.connectionString,
				queries: [] as string[],
				ended: false,
			};
			clients.push(this.state);
		}
		async connect() {
			return this;
		}
		async query(text: string) {
			if (this.state.ended) throw new Error("Client was closed and is not queryable");
			this.state.queries.push(text);
			return { command: "SELECT", rowCount: 0, rows: [] };
		}
		async end() {
			this.state.ended = true;
		}
	}
	class Pool {
		async connect(): Promise<never> {
			throw new Error("the per-isolate dialect must not pool connections");
		}
		async end() {}
	}
	return { Client, Pool };
});

vi.mock("emdash/database/instrumentation", () => ({
	kyselyLogOption: () => undefined,
}));

import { createDialect } from "../../src/db/hyperdrive.js";

describe("Hyperdrive per-isolate dialect", () => {
	beforeEach(() => {
		clients.length = 0;
	});

	it("opens a connection for each checkout and closes it on release", async () => {
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: createDialect({ binding: "HYPERDRIVE" }),
		});

		await Promise.all([sql`select 1`.execute(db), sql`select 2`.execute(db)]);
		await sql`select 3`.execute(db);

		expect(clients.map((c) => c.queries)).toEqual([["select 1"], ["select 2"], ["select 3"]]);
		expect(clients.every((c) => c.ended)).toBe(true);
		expect(clients.every((c) => c.connectionString === "postgres://primary/uncached")).toBe(true);
	});

	it("keeps a transaction on one connection", async () => {
		const db = new Kysely<Record<string, Record<string, unknown>>>({
			dialect: createDialect({ binding: "HYPERDRIVE" }),
		});

		await db.transaction().execute(async (trx) => {
			await sql`select 1`.execute(trx);
			await sql`select 2`.execute(trx);
		});

		expect(clients).toHaveLength(1);
		expect(clients[0]!.queries).toEqual(["begin", "select 1", "select 2", "commit"]);
		expect(clients[0]!.ended).toBe(true);
	});
});
