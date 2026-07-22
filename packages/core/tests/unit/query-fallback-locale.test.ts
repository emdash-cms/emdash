import { LiveEntryNotFoundError } from "astro/content/runtime";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import { getEmDashEntry } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../utils/test-db.js";

vi.mock("astro:content", () => ({
	getLiveCollection: vi.fn(),
	getLiveEntry: vi.fn(),
}));

import { getLiveEntry } from "astro:content";

describe("query helpers fallback locale resolution", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		setI18nConfig({
			defaultLocale: "id",
			locales: ["id", "en"],
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		setI18nConfig(null);
		vi.mocked(getLiveEntry).mockReset();
	});

	const createMockPost = (repo: ContentRepository, status: "published" | "draft") =>
		repo.create({
			type: "post",
			slug: "hello-world",
			data: { title: "Halo Dunia", status },
			locale: "id",
		});

	it("getEmDashEntry resolves entry with defaultLocale when requested locale has no live entry", async () => {
		const contentRepo = new ContentRepository(db);
		const post = await createMockPost(contentRepo, "published");

		vi.mocked(getLiveEntry).mockImplementation(async (_, options) => {
			if (options.locale === "en") {
				return {
					entry: undefined,
					error: new LiveEntryNotFoundError("post", "hello-world"),
				} as any;
			}
			if (options.locale === "id") {
				return {
					entry: {
						id: "hello-world",
						data: {
							id: post.id,
							title: "Halo Dunia",
							status: "published",
							locale: "id",
						},
					},
					error: undefined,
				} as any;
			}
			return { entry: undefined, error: new LiveEntryNotFoundError("post", "hello-world") } as any;
		});

		const { entry, fallbackLocale, error } = await runWithContext({ editMode: false, db }, () =>
			getEmDashEntry("post", "hello-world", { locale: "en" }),
		);

		expect(error).toBeUndefined();
		expect(entry).not.toBeNull();
		expect(entry?.data.title).toBe("Halo Dunia");
		expect(entry?.data.locale).toBe("id");
		expect(fallbackLocale).toBe("id");
	});

	it("getEmDashEntry resolves entry with defaultLocale in draft/preview mode when requested locale has no live entry", async () => {
		const contentRepo = new ContentRepository(db);
		const post = await createMockPost(contentRepo, "draft");

		vi.mocked(getLiveEntry).mockImplementation(async (_, options) => {
			if (options.locale === "en") {
				return {
					entry: undefined,
					error: new LiveEntryNotFoundError("post", "hello-world"),
				} as any;
			}
			if (options.locale === "id") {
				return {
					entry: {
						id: "hello-world",
						data: {
							id: post.id,
							title: "Halo Dunia",
							status: "draft",
							locale: "id",
						},
					},
					error: undefined,
				} as any;
			}
			return { entry: undefined, error: new LiveEntryNotFoundError("post", "hello-world") } as any;
		});

		const { entry, fallbackLocale, error, isPreview } = await runWithContext(
			{ editMode: true, db },
			() => getEmDashEntry("post", "hello-world", { locale: "en" }),
		);

		expect(error).toBeUndefined();
		expect(entry).not.toBeNull();
		expect(entry?.data.title).toBe("Halo Dunia");
		expect(entry?.data.locale).toBe("id");
		expect(fallbackLocale).toBe("id");
		expect(isPreview).toBe(true);
	});
});
