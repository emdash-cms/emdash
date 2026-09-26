import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("live evaluation migration", () => {
	it("can restart after its schema objects already exist", () => {
		const db = new DatabaseSync(":memory:");
		const migration = readFileSync(
			fileURLToPath(new URL("../migrations/0008_eval_runs.sql", import.meta.url).href),
			"utf8",
		);
		db.exec(migration);
		db.exec(migration);

		expect(
			db
				.prepare(
					`SELECT name FROM sqlite_master
					 WHERE type IN ('table', 'index') AND name LIKE 'eval_runs%'
					 ORDER BY name`,
				)
				.all(),
		).toEqual([
			{ name: "eval_runs" },
			{ name: "eval_runs_dataset_completed" },
			{ name: "eval_runs_status_created" },
			{ name: "eval_runs_workflow_instance" },
		]);
		db.close();
	});
});
