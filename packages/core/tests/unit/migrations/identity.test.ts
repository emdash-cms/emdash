import { describe, expect, it } from "vitest";

import {
	createCoreMigrationIdentity,
	fingerprintMigrationSet,
} from "../../../src/migrations/identity.js";

describe("fingerprintMigrationSet", () => {
	it("changes when the EmDash version changes", async () => {
		const names = ["001_initial", "002_media_status"];

		await expect(fingerprintMigrationSet("1.0.0", names)).resolves.not.toBe(
			await fingerprintMigrationSet("1.0.1", names),
		);
	});

	it("changes when migration order changes", async () => {
		await expect(
			fingerprintMigrationSet("1.0.0", ["001_initial", "002_media_status"]),
		).resolves.not.toBe(
			await fingerprintMigrationSet("1.0.0", ["002_media_status", "001_initial"]),
		);
	});

	it("is deterministic and encoded as a lowercase SHA-256 digest", async () => {
		const first = await fingerprintMigrationSet("1.0.0", ["001_initial"]);
		const second = await fingerprintMigrationSet("1.0.0", ["001_initial"]);

		expect(second).toBe(first);
		expect(first).toMatch(/^[0-9a-f]{64}$/);
	});
});

describe("createCoreMigrationIdentity", () => {
	it("returns the supplied version and an immutable snapshot of the ordered names", async () => {
		const names = ["001_initial", "002_media_status"];
		const identity = await createCoreMigrationIdentity("1.0.0", names);

		expect(identity).toEqual({
			emdashVersion: "1.0.0",
			names,
			fingerprint: await fingerprintMigrationSet("1.0.0", names),
		});
		expect(identity.names).not.toBe(names);
		expect(Object.isFrozen(identity.names)).toBe(true);
		expect(Object.isFrozen(identity)).toBe(true);
	});
});
