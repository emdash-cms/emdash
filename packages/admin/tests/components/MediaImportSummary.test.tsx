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
			"<p>1 file imported</p><p>1 image URL updated in 2 content items</p>",
		);

		expect(renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 })).toBe(
			"<p>2 files imported</p><p>3 image URLs updated in 1 content item</p>",
		);
	});

	it("lets translations reorder both counts without joining message fragments", () => {
		const i18n = setupI18n();
		const messageIds: string[] = [];
		i18n.load("ja", {});
		i18n.activate("ja");
		const removeMissingListener = i18n.on("missing", ({ id }) => messageIds.push(id));

		renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 }, i18n);
		removeMissingListener();

		expect(messageIds).toHaveLength(2);
		i18n.load("ja", {
			[messageIds[0]!]: "{importedFiles}件のファイルをインポートしました",
			[messageIds[1]!]:
				"{updatedContentItems}件のコンテンツで{rewrittenUrls}件の画像URLを更新しました",
		});

		expect(
			renderSummary({ importedFiles: 2, rewrittenUrls: 3, updatedContentItems: 1 }, i18n),
		).toBe(
			"<p>2件のファイルをインポートしました</p><p>1件のコンテンツで3件の画像URLを更新しました</p>",
		);
	});
});
