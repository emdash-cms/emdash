import { setupI18n, type I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaImportSummary } from "../../src/components/MediaImportSummary.js";

const IMPORTED_FILES_MESSAGE =
	"{importedFiles, plural, one {<count>#</count> file imported} other {<count>#</count> files imported}}";
const REWRITTEN_URLS_MESSAGE =
	"{rewrittenUrls, plural, one {<urlCount>#</urlCount> image URL updated in {updatedContentItems, plural, one {<itemCount>#</itemCount> content item} other {<itemCount>#</itemCount> content items}}} other {<urlCount>#</urlCount> image URLs updated in {updatedContentItems, plural, one {<itemCount>#</itemCount> content item} other {<itemCount>#</itemCount> content items}}}}";

function renderSummary(
	props: React.ComponentProps<typeof MediaImportSummary>,
	i18n: I18n = setupI18n({ locale: "en" }),
) {
	const html = renderToStaticMarkup(
		<I18nProvider i18n={i18n}>
			<MediaImportSummary {...props} />
		</I18nProvider>,
	);

	return html
		.replaceAll("</p>", "\n")
		.replaceAll(/<[^>]+>/g, "")
		.trim()
		.split("\n");
}

describe("MediaImportSummary", () => {
	it("renders each result as a complete pluralized message", () => {
		expect(renderSummary({ importedFiles: 1, rewrittenUrls: 1, updatedContentItems: 2 })).toEqual([
			"1 file imported",
			"1 image URL updated in 2 content items",
		]);

		expect(renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 })).toEqual([
			"2 files imported",
			"3 image URLs updated in 1 content item",
		]);
	});

	it("lets translations reorder both counts without joining message fragments", () => {
		const i18n = setupI18n();
		i18n.load("ja", {
			[IMPORTED_FILES_MESSAGE]: "<count>{importedFiles}</count>件のファイルをインポートしました",
			[REWRITTEN_URLS_MESSAGE]:
				"<itemCount>{updatedContentItems}</itemCount>件のコンテンツで<urlCount>{rewrittenUrls}</urlCount>件の画像URLを更新しました",
		});
		i18n.activate("ja");

		expect(
			renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 }, i18n),
		).toEqual(["2件のファイルをインポートしました", "1件のコンテンツで3件の画像URLを更新しました"]);
	});
});
