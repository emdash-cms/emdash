// POST /_emdash/api/setup applies sample content over several requests, each
// within Workers Free's 1,000 calls to D1, KV and R2.

import type { APIContext } from "astro";
import type {
	Kysely,
	KyselyPlugin,
	PluginTransformQueryArgs,
	PluginTransformResultArgs,
	QueryResult,
	RootOperationNode,
	UnknownRow,
} from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("virtual:emdash/seed", () => {
	const collections = ["menu_items", "experiences", "gallery_items", "pages"];
	return {
		seed: {
			version: "1",
			settings: {},
			collections: collections.map((slug) => ({
				slug,
				label: slug,
				fields: [
					{ slug: "title", label: "Title", type: "string" },
					{ slug: "body", label: "Body", type: "text" },
				],
			})),
			content: Object.fromEntries(
				collections.map((slug) => [
					slug,
					Array.from({ length: 28 }, (_, index) => ({
						id: `${slug}-${index}`,
						slug: `${slug}-${index}`,
						data: { title: `Entry ${index}`, body: `Body ${index}` },
					})),
				]),
			),
		},
		userSeed: null,
	};
});

import { POST as postSetup } from "../../../src/astro/routes/api/setup/index.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

class QueryCountingPlugin implements KyselyPlugin {
	count = 0;

	transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
		this.count += 1;
		return args.node;
	}

	transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		return Promise.resolve(args.result);
	}
}

interface SetupResponse {
	data: {
		seedComplete: boolean;
		seedProgress?: { done: number; total: number };
	};
}

async function postSetupCounted(db: Kysely<Database>): Promise<{
	status: number;
	body: SetupResponse;
	queries: number;
}> {
	const counter = new QueryCountingPlugin();
	const request = new Request("http://site.example/_emdash/api/setup", {
		method: "POST",
		headers: { "content-type": "application/json", host: "site.example" },
		body: JSON.stringify({ title: "My Site", includeContent: true }),
	});
	const response = await postSetup({
		params: {},
		url: new URL(request.url),
		request,
		locals: {
			emdash: {
				db: db.withPlugin(counter),
				config: { siteUrl: "http://site.example" },
				storage: undefined,
			},
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub
	} as unknown as APIContext);
	const body = (await response.json()) as SetupResponse;
	return { status: response.status, body, queries: counter.count };
}

async function countEntries(db: Kysely<Database>): Promise<number> {
	let total = 0;
	for (const table of ["ec_menu_items", "ec_experiences", "ec_gallery_items", "ec_pages"]) {
		const rows = await db
			.selectFrom(table as never)
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.executeTakeFirstOrThrow();
		total += rows.count;
	}
	return total;
}

describe("POST /setup with sample content", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("applies 112 entries over requests that each stay under 1,000 queries", async () => {
		const options = new OptionsRepository(db);
		const responses: Awaited<ReturnType<typeof postSetupCounted>>[] = [];
		const entriesAfter: number[] = [];
		let afterFirst: { siteUrl: unknown; setupState: unknown } | undefined;
		for (let request = 0; request < 20; request++) {
			const response = await postSetupCounted(db);
			responses.push(response);
			expect(response.status).toBe(200);
			entriesAfter.push(await countEntries(db));
			afterFirst ??= {
				siteUrl: await options.get("emdash:site_url"),
				setupState: await options.get("emdash:setup_state"),
			};
			if (response.body.data.seedComplete) break;
		}

		expect(Math.max(...responses.map((response) => response.queries))).toBeLessThan(1000);
		expect(responses.length).toBeGreaterThan(1);
		expect(responses.at(-1)?.body.data.seedComplete).toBe(true);
		expect(afterFirst).toEqual({ siteUrl: "http://site.example", setupState: null });

		const progress = responses.slice(0, -1).map((response) => response.body.data.seedProgress);
		expect(progress.every((step) => step?.total === 112)).toBe(true);
		const done = progress.map((step) => step?.done);
		expect(done).toEqual(entriesAfter.slice(0, -1));
		expect(new Set(done).size).toBe(done.length);

		expect(entriesAfter.at(-1)).toBe(112);
		expect(await options.get("emdash:setup_state")).toMatchObject({ step: "site_complete" });
	});
});
