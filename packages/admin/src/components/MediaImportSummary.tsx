import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

interface MediaImportSummaryProps {
	importedFiles: number;
	rewrittenUrls?: number;
	updatedContentItems?: number;
}

export function MediaImportSummary({
	importedFiles,
	rewrittenUrls,
	updatedContentItems,
}: MediaImportSummaryProps) {
	const { t } = useLingui();
	const importedFilesSummary = t({
		message: plural(importedFiles, {
			one: "# file imported",
			other: "# files imported",
		}),
	});
	const rewrittenUrlsSummary =
		rewrittenUrls !== undefined && updatedContentItems !== undefined
			? t({
					message: plural(rewrittenUrls, {
						one: `# image URL updated in ${plural(updatedContentItems, {
							one: "# content item",
							other: "# content items",
						})}`,
						other: `# image URLs updated in ${plural(updatedContentItems, {
							one: "# content item",
							other: "# content items",
						})}`,
					}),
				})
			: null;

	return (
		<>
			<p>{importedFilesSummary}</p>
			{rewrittenUrlsSummary !== null && <p>{rewrittenUrlsSummary}</p>}
		</>
	);
}
