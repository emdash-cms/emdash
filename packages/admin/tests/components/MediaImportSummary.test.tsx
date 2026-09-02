import { setupI18n, type I18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MediaImportSummary } from "../../src/components/MediaImportSummary.js";

function renderSummary(
	props: React.ComponentProps<typeof MediaImportSummary>,
	i18n: I18n = setupI18n({ locale: "en" }),
) {
	return renderToStaticMarkup(
		<I18nProvider i18n={i18n}>
			<MediaImportSummary {...props} />
		</I18nProvider>,
	);
}

describe("MediaImportSummary", () => {
	it("renders each result as a complete pluralized message", () => {
		expect(renderSummary({ importedFiles: 1, rewrittenUrls: 1, updatedContentItems: 2 })).toBe(
			"<p><strong>1</strong> file imported</p><p><strong>1</strong> image URL updated in <strong>2</strong> content items</p>",
		);

		expect(renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 })).toBe(
			"<p><strong>2</strong> files imported</p><p><strong>3</strong> image URLs updated in <strong>1</strong> content item</p>",
		);
	});

	it("lets translations reorder counts together with their emphasis", () => {
		const i18n = setupI18n();
		const messageIds: string[] = [];
		i18n.load("ja", {});
		i18n.activate("ja");
		const removeMissingListener = i18n.on("missing", ({ id }) => messageIds.push(id));

		renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 }, i18n);
		removeMissingListener();

		expect(messageIds).toHaveLength(2);
		const [importedFilesMessageId, updatedUrlsMessageId] = messageIds;
		i18n.load("ja", {
			[importedFilesMessageId!]: "<count>{importedFiles}</count>件のファイルをインポートしました",
			[updatedUrlsMessageId!]:
				"<contentCount>{updatedContentItems}</contentCount>件のコンテンツで<rewrittenCount>{rewrittenUrls}</rewrittenCount>件の画像URLを更新しました",
		});

		expect(
			renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 }, i18n),
		).toBe(
			"<p><strong>2</strong>件のファイルをインポートしました</p><p><strong>1</strong>件のコンテンツで<strong>3</strong>件の画像URLを更新しました</p>",
		);
	});
});
