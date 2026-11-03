import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isTranslationCatalog, unexpectedTranslationFiles } from "./translation-scope.mjs";

describe("translation scope", () => {
	it("recognizes translation catalogs", () => {
		assert.equal(isTranslationCatalog("packages/admin/src/locales/pt-BR/messages.po"), true);
		assert.equal(isTranslationCatalog("packages/admin/src/locales/locales.ts"), false);
		assert.equal(isTranslationCatalog("packages/admin/src/locales/de/nested/messages.po"), false);
	});

	it("accepts catalogs with locale registration and a changeset", () => {
		assert.deepEqual(
			unexpectedTranslationFiles([
				"packages/admin/src/locales/pt-PT/messages.po",
				"packages/admin/src/locales/locales.ts",
				"packages/admin/src/locales/day-picker.ts",
				".changeset/european-portuguese-admin-locale.md",
			]),
			[],
		);
	});

	it("lists other files changed alongside a catalog", () => {
		assert.deepEqual(
			unexpectedTranslationFiles([
				"packages/admin/src/locales/pt-PT/messages.po",
				"packages/admin/src/components/settings/GeneralSettings.tsx",
				"packages/admin/tests/lib/locales.test.ts",
				".changeset/nested/not-a-changeset.md",
			]),
			[
				"packages/admin/src/components/settings/GeneralSettings.tsx",
				"packages/admin/tests/lib/locales.test.ts",
				".changeset/nested/not-a-changeset.md",
			],
		);
	});

	it("does not apply when no catalog changed", () => {
		assert.deepEqual(
			unexpectedTranslationFiles(["packages/admin/src/components/Editor.tsx", ".changeset/a.md"]),
			[],
		);
	});
});
