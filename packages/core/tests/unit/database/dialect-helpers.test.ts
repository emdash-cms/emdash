import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { Kysely, PostgresAdapter, SqliteAdapter, SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	detectDialect,
	jsonExtractExpr,
	pluginDataExtractExpr,
	pluginDataOrderExpr,
} from "../../../src/database/dialect-helpers.js";

describe("dialect detection with duplicate Kysely modules", () => {
	let directory: string;
	let isolated: typeof import("kysely");

	beforeAll(async () => {
		directory = mkdtempSync(join(tmpdir(), "emdash-kysely-"));
		const entry = createRequire(import.meta.url).resolve("kysely");
		// Copy the module graph, not just the entrypoint: its relative imports
		// must also have distinct identities, as with Vite SSR prebundling.
		cpSync(dirname(dirname(entry)), directory, { recursive: true });
		isolated = await import(
			/* @vite-ignore */ pathToFileURL(join(directory, "dist/index.js")).href
		);
	});

	afterAll(() => {
		if (directory) rmSync(directory, { recursive: true, force: true });
	});

	it("uses PostgreSQL JSON expressions for an adapter from another module copy", () => {
		const db = new isolated.Kysely({
			dialect: new isolated.PostgresDialect({ pool: {} as never }),
		});

		expect(db.getExecutor().adapter).not.toBeInstanceOf(PostgresAdapter);
		expect(detectDialect(db)).toBe("postgres");
		expect(jsonExtractExpr(db, "data", "createdAt")).toBe("(data)::jsonb->>'createdAt'");
		expect(pluginDataExtractExpr(db, "createdAt")).toBe("(data)::jsonb->>'createdAt'");
		expect(pluginDataOrderExpr(db, "createdAt")).toBe("(data)::jsonb->'createdAt'");
	});

	it("keeps SQLite JSON expressions for an adapter from another module copy", () => {
		const db = new isolated.Kysely({
			dialect: new isolated.SqliteDialect({ database: {} as never }),
		});

		expect(db.getExecutor().adapter).not.toBeInstanceOf(SqliteAdapter);
		expect(detectDialect(db)).toBe("sqlite");
		expect(pluginDataExtractExpr(db, "createdAt")).toBe("json_extract(data, '$.createdAt')");
		expect(pluginDataOrderExpr(db, "createdAt")).toBe("json_extract(data, '$.createdAt')");
	});

	it("does not classify a multi-connection SQLite adapter as PostgreSQL", () => {
		class MultiConnectionAdapter extends SqliteAdapter {
			override get supportsMultipleConnections(): boolean {
				return true;
			}
		}
		class MultiConnectionDialect extends SqliteDialect {
			override createAdapter(): SqliteAdapter {
				return new MultiConnectionAdapter();
			}
		}
		const db = new Kysely({
			dialect: new MultiConnectionDialect({ database: {} as never }),
		});

		expect(detectDialect(db)).toBe("sqlite");
	});
});
