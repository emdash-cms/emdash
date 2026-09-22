import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

describe("issuance control migration", () => {
	it("restores state and ordering from the newest durable action", () => {
		const db = new DatabaseSync(":memory:");
		db.exec(readMigration("0001_initial.sql"));
		const insert = db.prepare(
			`INSERT INTO operator_actions
			   (actor_did, actor_role, action, subject_uri, subject_cid, reason,
			    idempotency_key, created_at)
			 VALUES (?, 'admin', ?, NULL, NULL, ?, ?, ?)`,
		);
		insert.run(
			"did:web:labels.example:operators:admin",
			"pause-issuance",
			"Pause",
			"migration-pause-001",
			"2026-08-25T10:00:00.000Z",
		);
		insert.run(
			"did:web:labels.example:operators:admin",
			"resume-issuance",
			"Resume",
			"migration-resume-001",
			"2026-08-25T10:01:00.000Z",
		);
		db.prepare(
			`INSERT INTO service_state (key, value, updated_at)
			 VALUES ('issuance_paused', '1', '2026-08-25T10:02:00.000Z')`,
		).run();

		db.exec(readMigration("0007_issuance_control_order.sql"));

		expect(
			db
				.prepare(
					`SELECT key, value, updated_at FROM service_state
					 WHERE key IN ('issuance_paused', 'issuance_control_action_id')
					 ORDER BY key`,
				)
				.all(),
		).toEqual([
			{
				key: "issuance_control_action_id",
				value: "2",
				updated_at: "2026-08-25T10:01:00.000Z",
			},
			{
				key: "issuance_paused",
				value: "0",
				updated_at: "2026-08-25T10:01:00.000Z",
			},
		]);
		db.close();
	});
});

function readMigration(name: string): string {
	return readFileSync(
		fileURLToPath(new URL(`../migrations/${name}`, import.meta.url).href),
		"utf8",
	);
}
