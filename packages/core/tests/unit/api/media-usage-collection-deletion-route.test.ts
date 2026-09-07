import { Role, type RoleLevel } from "@emdash-cms/auth";
import { expect, it } from "vitest";

import { GET } from "../../../src/astro/routes/api/admin/media-usage/collection-deletions/index.js";
import { POST } from "../../../src/astro/routes/api/admin/media-usage/collection-deletions/retry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

it("requires schema permission and admin scope for collection deletion recovery", async () => {
	const db = await setupTestDatabase();
	try {
		const list = new Request(
			"http://localhost/_emdash/api/admin/media-usage/collection-deletions?state=failed",
		);
		await expectError(await GET(context(db, list, Role.EDITOR, ["admin"])), 403, "FORBIDDEN");
		await expectError(
			await GET(context(db, list, Role.ADMIN, ["content:read"])),
			403,
			"INSUFFICIENT_SCOPE",
		);
		const retry = new Request(
			"http://localhost/_emdash/api/admin/media-usage/collection-deletions/retry",
			{
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({ collectionId: "missing" }),
			},
		);
		await expectError(await POST(context(db, retry, Role.EDITOR, ["admin"])), 403, "FORBIDDEN");
	} finally {
		await teardownTestDatabase(db);
	}
});

function context(
	db: Awaited<ReturnType<typeof setupTestDatabase>>,
	request: Request,
	role: RoleLevel,
	scopes: string[],
) {
	return {
		request,
		locals: {
			emdash: { db },
			user: { id: "user-1", email: "admin@example.com", name: "Admin", role },
			tokenScopes: scopes,
		},
	} as never;
}

async function expectError(response: Response, status: number, code: string) {
	expect(response.status).toBe(status);
	expect((await response.json()) as { error: { code: string } }).toMatchObject({
		error: expect.objectContaining({ code }),
	});
}
