/**
 * POST /_emdash/api/setup writes `emdash:site_url` once. Subsequent calls
 * to the setup endpoint (during the multi-step wizard, before
 * `emdash:setup_complete` is true) must not overwrite it.
 *
 * Without this, a spoofed Host header on any follow-up POST during the
 * setup window could poison the site URL used in auth emails.
 *
 * The primary defence (config.siteUrl / EMDASH_SITE_URL env) was added
 * earlier; this is the last-line lock for deployments that rely on the
 * request-origin fallback.
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub the seed virtual module that loadSeed() imports at runtime. Without
// this the setup route errors out before reaching the site_url write.
vi.mock("virtual:emdash/seed", () => ({
	seed: {
		version: "1",
		settings: {},
		collections: [],
	},
	userSeed: null,
}));

import { POST as postSetup } from "../../../src/astro/routes/api/setup/index.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function buildRequest(host: string, body: unknown): Request {
	return new Request(`http://${host}/_emdash/api/setup`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			host,
		},
		body: JSON.stringify(body),
	});
}

function buildContext(db: Kysely<Database>, request: Request): APIContext {
	return {
		params: {},
		url: new URL(request.url),
		request,
		locals: {
			emdash: {
				db,
				config: {},
				storage: undefined,
			},
		},
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub
	} as unknown as APIContext;
}

describe("POST /setup — site_url write-once lock", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("stores site_url from the first request", async () => {
		const res = await postSetup(
			buildContext(
				db,
				buildRequest("real-site.example", { title: "My Site", includeContent: false }),
			),
		);
		expect(res.status).toBe(200);

		const options = new OptionsRepository(db);
		expect(await options.get("emdash:site_url")).toBe("http://real-site.example");
	});

	it("does not overwrite site_url when a later setup call arrives with a spoofed Host", async () => {
		// First call — legitimate admin on the real host.
		const first = await postSetup(
			buildContext(
				db,
				buildRequest("real-site.example", { title: "My Site", includeContent: false }),
			),
		);
		expect(first.status).toBe(200);

		// Attacker sends a second setup call with a spoofed Host header
		// before the admin has completed the final step. Without the lock,
		// the stored site_url would be overwritten.
		const second = await postSetup(
			buildContext(
				db,
				buildRequest("attacker.example", { title: "My Site", includeContent: false }),
			),
		);
		expect(second.status).toBe(200);

		const options = new OptionsRepository(db);
		expect(await options.get("emdash:site_url")).toBe("http://real-site.example");
	});

	it("is atomic under concurrent setup POSTs with different Hosts", async () => {
		// Two concurrent callers observe an empty site_url and race to
		// write. Without DB-level write-once semantics, the last writer
		// wins and the legitimate host can still be replaced.
		const [a, b] = await Promise.all([
			postSetup(
				buildContext(
					db,
					buildRequest("real-site.example", { title: "My Site", includeContent: false }),
				),
			),
			postSetup(
				buildContext(
					db,
					buildRequest("attacker.example", { title: "My Site", includeContent: false }),
				),
			),
		]);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);

		const options = new OptionsRepository(db);
		const stored = await options.get("emdash:site_url");
		// Whichever call won the race must now stick — a third caller must
		// not be able to overwrite it.
		expect(["http://real-site.example", "http://attacker.example"]).toContain(stored);

		const third = await postSetup(
			buildContext(db, buildRequest("other.example", { title: "My Site", includeContent: false })),
		);
		expect(third.status).toBe(200);
		expect(await options.get("emdash:site_url")).toBe(stored);
	});

	it("does not overwrite a legitimately-stored empty string", async () => {
		// Defence-in-depth: if site_url was somehow stored as "" (e.g.
		// manual DB edit, legacy data, test fixture), the guard must treat
		// it as present, not missing.
		const options = new OptionsRepository(db);
		await options.set("emdash:site_url", "");

		const res = await postSetup(
			buildContext(
				db,
				buildRequest("attacker.example", { title: "My Site", includeContent: false }),
			),
		);
		expect(res.status).toBe(200);

		expect(await options.get("emdash:site_url")).toBe("");
	});
});
