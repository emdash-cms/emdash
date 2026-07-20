import { applyD1Migrations, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

interface TestEnv {
	DB: D1Database;
	TEST_MIGRATIONS: Parameters<typeof applyD1Migrations>[1];
}
const testEnv = env as unknown as TestEnv;

describe("0003_label_history_identity", () => {
	it("refuses to run when label rows already exist", async () => {
		const migrations = testEnv.TEST_MIGRATIONS;
		const guarded = migrations.findIndex((m) => m.name.includes("0003_label_history_identity"));
		expect(guarded).toBeGreaterThan(0);

		await applyD1Migrations(testEnv.DB, migrations.slice(0, guarded));
		await testEnv.DB.prepare(
			`INSERT INTO labels (src, uri, val, cts, sig, received_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
			.bind(
				"did:web:labels.example",
				"at://did:plc:x/com.emdashcms.experimental.package.release/pkg:1.0.0",
				"security-yanked",
				"2026-01-01T00:00:00.000Z",
				new Uint8Array([1, 2, 3]),
				"2026-01-01T00:00:00.000Z",
			)
			.run();

		await expect(
			applyD1Migrations(testEnv.DB, migrations.slice(guarded, guarded + 1)),
		).rejects.toThrow();
	});
});
