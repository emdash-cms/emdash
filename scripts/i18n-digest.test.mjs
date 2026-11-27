import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMessage, catalogKeys, weekCutoff } from "./i18n-digest.mjs";

const catalogPath = (lang) => `packages/admin/src/locales/${lang}/messages.po`;
const link = (lang) =>
	`[${lang}](https://github.com/emdash-cms/emdash/blob/main/${catalogPath(lang)})`;

describe("buildMessage", () => {
	it("groups every locale by how much is missing, closest first, counting only the nearly done", () => {
		const locales = [
			["uk", 278],
			["ja", 0],
			["fa", 2827],
			["lt", 14],
			["it", 11],
			["de", 0],
		].map(([lang, missing]) => ({ lang, path: catalogPath(lang), missing }));

		const [embed] = buildMessage({ count: 16, locales, since: "2026-11-16" }).embeds;

		assert.ok(
			embed.description.includes(
				[
					"**Complete**",
					"de · ja",
					"",
					"**Under 100 missing**",
					`${link("it")} 11 · ${link("lt")} 14`,
					"",
					"**100 to 999 missing**",
					link("uk"),
					"",
					"**1,000 or more missing**",
					link("fa"),
					"",
				].join("\n"),
			),
		);
	});

	it("keeps the links on the closest locales when the full list would not fit", () => {
		const locales = Array.from({ length: 60 }, (_, index) => {
			const lang = `x${String(index).padStart(2, "0")}`;
			return { lang, path: catalogPath(lang), missing: (index + 1) * 20 };
		});

		const [embed] = buildMessage({ count: 16, locales, since: "2026-11-16" }).embeds;

		assert.ok(embed.description.length <= 4096);
		assert.ok(embed.description.includes(`**Under 100 missing**\n${link("x00")} 20 · `));
		assert.ok(embed.description.includes(`**100 to 999 missing**\n${link("x04")} · `));
		assert.ok(embed.description.includes(" · x59\n"));
	});
});

describe("weekCutoff", () => {
	it("leaves no gap between two weekly runs that start late", () => {
		const previousRun = Date.parse("2026-11-13T07:05:00Z");
		const run = Date.parse("2026-11-20T09:40:00Z");

		assert.ok(weekCutoff(run).getTime() <= previousRun);
	});
});

describe("catalogKeys", () => {
	it("keeps a msgid under a new context apart from the same msgid without one", () => {
		const catalog = [
			'msgid ""',
			'msgstr ""',
			"",
			'msgid "Default"',
			'msgstr "Default"',
			"",
			'msgctxt "button style"',
			'msgid "Default"',
			'msgstr "Default"',
			"",
		].join("\n");

		assert.deepEqual(catalogKeys(catalog), [["Default"], ["button style", "Default"]]);
	});
});
