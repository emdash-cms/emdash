import { plural } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
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
	return (
		<>
			<p>
				<Trans>
					<strong>{importedFiles}</strong>{" "}
					{plural(importedFiles, { one: "file imported", other: "files imported" })}
				</Trans>
			</p>
			{rewrittenUrls !== undefined && updatedContentItems !== undefined && (
				<p>
					<Trans>
						<strong>{rewrittenUrls}</strong>{" "}
						{plural(rewrittenUrls, {
							one: "image URL updated",
							other: "image URLs updated",
						})}{" "}
						in <strong>{updatedContentItems}</strong>{" "}
						{plural(updatedContentItems, {
							one: "content item",
							other: "content items",
						})}
					</Trans>
				</p>
			)}
		</>
	);
}
