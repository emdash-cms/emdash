import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { DELETE } from "../../../src/astro/routes/api/admin/scheduled-policy-rejections/[collection]/[id].js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { scheduledPolicyRejectionKey } from "../../../src/plugins/content-policy.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("DELETE /admin/scheduled-policy-rejections/:collection/:id", () => {
	let db: Kysely<Database>;

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function context(role: RoleLevel, revision: string): APIContext {
		return {
			params: { collection: "posts", id: "post-1" },
			locals: { emdash: { db }, user: { id: "user-1", role } },
			url: new URL(
				`http://localhost/_emdash/api/admin/scheduled-policy-rejections/posts/post-1?rev=${encodeURIComponent(revision)}`,
			),
		} as unknown as APIContext;
	}

	it("lets publishers dismiss the displayed rejection revision", async () => {
		db = await setupTestDatabase();
		const options = new OptionsRepository(db);
		const key = scheduledPolicyRejectionKey("posts", "post-1");
		await options.set(key, { reason: "Approval is required." });
		const displayed = await options.getVersioned(key);
		if (!displayed) throw new Error("Expected rejection record");

		const response = await DELETE(context(Role.EDITOR, displayed.revision));

		expect(response.status).toBe(200);
		await expect(options.get(key)).resolves.toBeNull();
	});

	it("does not let a reader clear publication-policy attention", async () => {
		db = await setupTestDatabase();
		const options = new OptionsRepository(db);
		const key = scheduledPolicyRejectionKey("posts", "post-1");
		await options.set(key, { reason: "Approval is required." });
		const displayed = await options.getVersioned(key);
		if (!displayed) throw new Error("Expected rejection record");

		const response = await DELETE(context(Role.SUBSCRIBER, displayed.revision));

		expect(response.status).toBe(403);
		await expect(options.get(key)).resolves.not.toBeNull();
	});

	it("does not let a stale dismissal erase a newer rejection", async () => {
		db = await setupTestDatabase();
		const options = new OptionsRepository(db);
		const key = scheduledPolicyRejectionKey("posts", "post-1");
		await options.set(key, { reason: "First rejection" });
		const displayed = await options.getVersioned(key);
		if (!displayed) throw new Error("Expected rejection record");
		await options.set(key, { reason: "New rejection" });

		const response = await DELETE(context(Role.EDITOR, displayed.revision));

		expect(response.status).toBe(409);
		await expect(options.get(key)).resolves.toEqual({ reason: "New rejection" });
	});
});
