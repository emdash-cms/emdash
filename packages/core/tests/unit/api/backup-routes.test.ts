/**
 * Backup route tests
 *
 * - Route registration for all four backup endpoints
 * - Authorization: every endpoint requires the admin-only backups:manage
 *   permission
 * - The public media file route must never serve keys under backups/
 *   (archives contain the site's full content export)
 */

import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { GET as mediaFileGet } from "../../../src/astro/routes/api/media/file/[...key].js";
import {
	DELETE as archiveDelete,
	GET as archiveGet,
} from "../../../src/astro/routes/api/settings/backups/archives/[name].js";
import { POST as archivesPost } from "../../../src/astro/routes/api/settings/backups/archives/index.js";
import { GET as exportGet } from "../../../src/astro/routes/api/settings/backups/export.js";
import {
	GET as backupsGet,
	PUT as backupsPut,
} from "../../../src/astro/routes/api/settings/backups/index.js";

// Minimal APIContext stand-in; routes only touch locals/params/request.
// eslint-disable-next-line typescript/no-explicit-any -- test double for APIContext
function ctx(overrides: Record<string, unknown>): any {
	return {
		locals: { emdash: { db: {}, storage: {} }, user: null },
		params: {},
		request: new Request("https://example.com"),
		...overrides,
	};
}

describe("backup route registration", () => {
	it("registers all backup routes", () => {
		const injectRoute = vi.fn();
		injectCoreRoutes(injectRoute);

		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/settings/backups");
		expect(patterns).toContain("/_emdash/api/settings/backups/export");
		expect(patterns).toContain("/_emdash/api/settings/backups/archives");
		expect(patterns).toContain("/_emdash/api/settings/backups/archives/[name]");
	});
});

describe("backup route authorization", () => {
	const cases: [string, (c: unknown) => Promise<Response>][] = [
		["GET /settings/backups", (c) => backupsGet(c as never)],
		["PUT /settings/backups", (c) => backupsPut(c as never)],
		["GET /settings/backups/export", (c) => exportGet(c as never)],
		["POST /settings/backups/archives", (c) => archivesPost(c as never)],
		["GET /settings/backups/archives/[name]", (c) => archiveGet(c as never)],
		["DELETE /settings/backups/archives/[name]", (c) => archiveDelete(c as never)],
	];

	for (const [label, invoke] of cases) {
		it(`${label} rejects anonymous requests`, async () => {
			const res = await invoke(
				ctx({ params: { name: "emdash-backup-2026-07-09T08-45-12-abcd1234.json" } }),
			);
			expect(res.status).toBe(401);
		});

		it(`${label} rejects editors (below admin)`, async () => {
			const res = await invoke(
				ctx({
					locals: { emdash: { db: {}, storage: {} }, user: { id: "u1", role: 40 } },
					params: { name: "emdash-backup-2026-07-09T08-45-12-abcd1234.json" },
				}),
			);
			expect(res.status).toBe(403);
		});
	}
});

describe("media file route denies backup archives", () => {
	it("returns 404 for keys under backups/ without touching storage", async () => {
		const download = vi.fn();
		const res = await mediaFileGet(
			ctx({
				params: { key: "backups/emdash-backup-2026-07-09T08-45-12-abcd1234.json" },
				locals: { emdash: { storage: { download } } },
			}) as never,
		);
		expect(res.status).toBe(404);
		expect(download).not.toHaveBeenCalled();
	});
});
