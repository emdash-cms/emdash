import { afterEach, beforeEach, expect, it } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import { createBylineAccess } from "../../../src/plugins/byline-access.js";
import { PluginContextFactory } from "../../../src/plugins/context.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ENTRY_LIMIT_REGEX = /at most 100 entry IDs/;
const INVALID_COLLECTION_REGEX = /collection must match/;

function createTestPlugin(capabilities: ResolvedPlugin["capabilities"]): ResolvedPlugin {
	return {
		id: "byline-test",
		version: "1.0.0",
		capabilities,
		allowedHosts: [],
		storage: {},
		admin: { pages: [], widgets: [], fieldWidgets: {} },
		hooks: {},
		routes: {},
		settings: undefined,
	};
}

describeEachDialect("plugin byline access", (dialect) => {
	let ctx: DialectTestContext;
	let bylineRepo: BylineRepository;
	let contentRepo: ContentRepository;
	let userRepo: UserRepository;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		bylineRepo = new BylineRepository(ctx.db);
		contentRepo = new ContentRepository(ctx.db);
		userRepo = new UserRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("is exposed on the context only with bylines:read", () => {
		const factory = new PluginContextFactory({ db: ctx.db });
		expect(factory.createContext(createTestPlugin(["content:read"])).bylines).toBeUndefined();
		expect(factory.createContext(createTestPlugin(["bylines:read"])).bylines).toBeDefined();
	});

	it("returns public profile fields without account links or custom fields", async () => {
		const user = await userRepo.create({
			email: "jane@example.com",
			displayName: "Jane Account",
			role: "editor",
		});
		const created = await bylineRepo.create({
			slug: "jane-doe",
			displayName: "Jane Doe",
			bio: "Writes about gardens.",
			websiteUrl: "https://jane.example.com",
			userId: user.id,
		});

		const byline = await createBylineAccess(ctx.db).get(created.id);

		expect(byline).toEqual({
			id: created.id,
			slug: "jane-doe",
			displayName: "Jane Doe",
			bio: "Writes about gardens.",
			websiteUrl: "https://jane.example.com",
			avatarMediaId: null,
			locale: created.locale,
			translationGroup: created.translationGroup,
		});
	});

	it("paginates bylines by cursor and filters by locale", async () => {
		for (const slug of ["a", "b", "c"]) {
			await bylineRepo.create({ slug, displayName: slug.toUpperCase(), locale: "en" });
		}
		await bylineRepo.create({ slug: "d", displayName: "D", locale: "fr" });
		const access = createBylineAccess(ctx.db);

		const first = await access.list({ locale: "en", limit: 2 });
		expect(first.items).toHaveLength(2);
		expect(first.hasMore).toBe(true);
		const second = await access.list({ locale: "en", limit: 2, cursor: first.cursor });
		expect(second.hasMore).toBe(false);
		expect(second.cursor).toBeUndefined();

		const slugs = [...first.items, ...second.items].map((byline) => byline.slug).toSorted();
		expect(slugs).toEqual(["a", "b", "c"]);
	});

	it("resolves explicit and inferred credits at each entry's locale", async () => {
		const author = await userRepo.create({
			email: "author@example.com",
			displayName: "Author",
			role: "editor",
		});
		await bylineRepo.create({ slug: "author", displayName: "Author", userId: author.id });
		const lead = await bylineRepo.create({ slug: "lead", displayName: "Lead", locale: "en" });
		await bylineRepo.create({
			slug: "lead",
			displayName: "Lead (FR)",
			locale: "fr",
			translationOf: lead.id,
		});
		const editor = await bylineRepo.create({ slug: "editor", displayName: "Editor" });

		const credited = await contentRepo.create({
			type: "post",
			slug: "credited",
			data: { title: "Credited" },
			locale: "en",
		});
		await bylineRepo.setContentBylines("post", credited.id, [
			{ bylineId: lead.id },
			{ bylineId: editor.id, roleLabel: "Editor" },
		]);
		const french = await contentRepo.create({
			type: "post",
			slug: "credited-fr",
			data: { title: "Crédité" },
			locale: "fr",
		});
		await bylineRepo.setContentBylines("post", french.id, [{ bylineId: lead.id }]);
		const authored = await contentRepo.create({
			type: "post",
			slug: "authored",
			data: { title: "Authored" },
			authorId: author.id,
		});
		const trashed = await contentRepo.create({
			type: "post",
			slug: "trashed",
			data: { title: "Trashed" },
		});
		await bylineRepo.setContentBylines("post", trashed.id, [{ bylineId: editor.id }]);
		await contentRepo.delete("post", trashed.id);

		const result = await createBylineAccess(ctx.db).getEntriesBylines("post", [
			credited.id,
			french.id,
			authored.id,
			trashed.id,
			"missing",
			credited.id,
		]);

		expect(result.map((entry) => entry.entryId)).toEqual([
			credited.id,
			french.id,
			authored.id,
			trashed.id,
			"missing",
		]);
		expect(
			result[0]!.bylines.map(({ byline, roleLabel, source }) => ({
				name: byline.displayName,
				roleLabel,
				source,
			})),
		).toEqual([
			{ name: "Lead", roleLabel: null, source: "explicit" },
			{ name: "Editor", roleLabel: "Editor", source: "explicit" },
		]);
		expect(result[1]!.bylines.map((credit) => credit.byline.displayName)).toEqual(["Lead (FR)"]);
		expect(result[2]!.bylines).toEqual([
			expect.objectContaining({
				source: "inferred",
				byline: expect.objectContaining({ slug: "author" }),
			}),
		]);
		expect(result[2]!.bylines[0]!.byline).not.toHaveProperty("userId");
		expect(result[3]!.bylines).toEqual([]);
		expect(result[4]!.bylines).toEqual([]);
	});

	it("rejects oversized batches and invalid collection names", async () => {
		const access = createBylineAccess(ctx.db);
		const ids = Array.from({ length: 101 }, (_, index) => `entry-${index}`);

		await expect(access.getEntriesBylines("post", ids)).rejects.toThrow(ENTRY_LIMIT_REGEX);
		await expect(access.getEntriesBylines("post; DROP TABLE users", ["x"])).rejects.toThrow(
			INVALID_COLLECTION_REGEX,
		);
	});
});
