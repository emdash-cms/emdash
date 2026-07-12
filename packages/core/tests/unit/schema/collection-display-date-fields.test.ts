/**
 * #1133: a collection's `displayField`/`dateField` override the admin list's
 * Title and Date columns. Update-only (fields must exist first), so
 * `updateCollection` validates: displayField = a real field, dateField = a
 * `datetime` field; `null`/`""` clears to default; unset stays undefined.
 */
import Database from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { SchemaRegistry, SchemaError } from "../../../src/schema/registry.js";

describe("collection displayField/dateField (#1133)", () => {
	let db: Kysely<EmDashDatabase>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		const sqlite = new Database(":memory:");
		db = new Kysely<EmDashDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
		await runMigrations(db);
		registry = new SchemaRegistry(db);

		await registry.createCollection({
			slug: "employees",
			label: "Employees",
			supports: ["drafts"],
		});
		await registry.createField("employees", { slug: "name", label: "Name", type: "string" });
		await registry.createField("employees", { slug: "title", label: "Job Title", type: "string" });
		await registry.createField("employees", {
			slug: "pub_date",
			label: "Start Date",
			type: "datetime",
		});
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("defaults to undefined when unset", async () => {
		const collection = await registry.getCollection("employees");
		expect(collection?.displayField).toBeUndefined();
		expect(collection?.dateField).toBeUndefined();
	});

	it("updateCollection sets displayField and dateField to valid fields", async () => {
		const updated = await registry.updateCollection("employees", {
			displayField: "name",
			dateField: "pub_date",
		});
		expect(updated.displayField).toBe("name");
		expect(updated.dateField).toBe("pub_date");

		const reread = await registry.getCollection("employees");
		expect(reread?.displayField).toBe("name");
		expect(reread?.dateField).toBe("pub_date");
	});

	it("clears displayField/dateField back to default with null", async () => {
		await registry.updateCollection("employees", { displayField: "name", dateField: "pub_date" });
		const cleared = await registry.updateCollection("employees", {
			displayField: null,
			dateField: null,
		});
		expect(cleared.displayField).toBeUndefined();
		expect(cleared.dateField).toBeUndefined();
	});

	it("leaves displayField/dateField unchanged on an unrelated update", async () => {
		await registry.updateCollection("employees", { displayField: "name", dateField: "pub_date" });
		const updated = await registry.updateCollection("employees", { label: "Team" });
		expect(updated.displayField).toBe("name");
		expect(updated.dateField).toBe("pub_date");
	});

	it("updateCollection rejects a displayField that does not exist", async () => {
		await expect(
			registry.updateCollection("employees", { displayField: "nonexistent" }),
		).rejects.toBeInstanceOf(SchemaError);
	});

	it("updateCollection rejects a displayField that isn't a text field", async () => {
		// `pub_date` is a datetime field — a raw date reads poorly as a title.
		await expect(
			registry.updateCollection("employees", { displayField: "pub_date" }),
		).rejects.toBeInstanceOf(SchemaError);
	});

	it("updateCollection rejects a dateField that is not a datetime field", async () => {
		await expect(
			registry.updateCollection("employees", { dateField: "title" }),
		).rejects.toBeInstanceOf(SchemaError);
	});

	it("updateCollection rejects a dateField that does not exist", async () => {
		await expect(
			registry.updateCollection("employees", { dateField: "nope" }),
		).rejects.toBeInstanceOf(SchemaError);
	});

	it("clears displayField/dateField when the referenced field is deleted", async () => {
		await registry.updateCollection("employees", { displayField: "name", dateField: "pub_date" });

		// Deleting the field that powers dateField must clear the reference, so
		// the content list doesn't later sort by a dropped column.
		await registry.deleteField("employees", "pub_date");
		const afterDate = await registry.getCollection("employees");
		expect(afterDate?.dateField).toBeUndefined();
		expect(afterDate?.displayField).toBe("name"); // unrelated reference untouched

		await registry.deleteField("employees", "name");
		const afterName = await registry.getCollection("employees");
		expect(afterName?.displayField).toBeUndefined();
	});
});
