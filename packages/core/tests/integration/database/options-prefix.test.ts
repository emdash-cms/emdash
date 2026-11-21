import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("options prefix reads", (dialect) => {
	let ctx: DialectTestContext;
	let repo: OptionsRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new OptionsRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	for (const method of ["getByPrefix", "getVersionedByPrefix"] as const) {
		describe(method, () => {
			async function expectMatches(prefix: string, names: string[]) {
				const result = await repo[method](prefix);
				expect(new Set(result.keys())).toEqual(new Set(names));
				for (const [name, value] of result) {
					if (method === "getByPrefix") expect(value).toEqual({ name });
					else expect(value).toEqual(await repo.getVersioned(name));
				}
			}

			it("matches literal wildcard and escape characters", async () => {
				const names = [
					"plugin:a%:key",
					"plugin:abc:key",
					"plugin:a_:key",
					"plugin:ab:key",
					"plugin:a\\:key",
				];
				for (const name of names) await repo.set(name, { name });
				for (const name of [names[0], names[2], names[4]]) {
					await expectMatches(name.slice(0, -3), [name]);
				}
				await expectMatches("missing:", []);
			});

			it("includes an exact prefix and excludes neighboring names", async () => {
				const names = [
					"plugin:x:settings:",
					"plugin:x:settings:a",
					"plugin:x:settings",
					"plugin:x:settings;",
				];
				for (const name of names) await repo.set(name, { name });
				await expectMatches("plugin:x:settings:", names.slice(0, 2));
			});

			it("lists every option for an empty prefix and honors zero and negative limits", async () => {
				const names = ["a", "z", "😀"];
				for (const name of names) await repo.set(name, { name });
				const all = await repo.getAll();
				expect(new Set((await repo[method]("")).keys())).toEqual(new Set(all.keys()));
				expect(await repo[method]("", { limit: 0 })).toEqual(new Map());
				expect(await repo[method]("", { limit: -1 })).toEqual(new Map());
			});

			it.each(["é", "😀", "\ud7ff", "\uffff", "a\u{10ffff}", "\u{10ffff}", "\u{10ffff}\u{10ffff}"])(
				"includes all Unicode suffixes of %s without leaking adjacent names",
				async (prefix) => {
					const matching = [
						prefix,
						`${prefix}:value`,
						`${prefix}\u{10ffff}`,
						`${prefix}\u{10ffff}tail`,
					];
					const neighbors = ["a", "b", "é", "ê", "😁", "\ue000", "\u{10000}", "\u{10ffff}"];
					const names = [...new Set([...matching, ...neighbors])];
					for (const name of names) await repo.set(name, { name });
					await expectMatches(
						prefix,
						names.filter((name) => name.startsWith(prefix)),
					);
				},
			);

			it("preserves each dialect's LIKE case matching", async () => {
				for (const name of ["plugin:seo:Stats", "plugin:seo:stats"]) {
					await repo.set(name, { name });
				}
				if (dialect === "sqlite") {
					await expectMatches("plugin:seo:S", ["plugin:seo:Stats", "plugin:seo:stats"]);
					await expectMatches("plugin:seo:s", ["plugin:seo:Stats", "plugin:seo:stats"]);
				} else {
					await expectMatches("plugin:seo:S", ["plugin:seo:Stats"]);
					await expectMatches("plugin:seo:s", ["plugin:seo:stats"]);
				}
			});
		});
	}
});
