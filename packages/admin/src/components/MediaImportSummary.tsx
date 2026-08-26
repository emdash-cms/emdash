import { Trans } from "@lingui/react";
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
				<Trans
					id="{importedFiles, plural, one {<count>#</count> file imported} other {<count>#</count> files imported}}"
					values={{ importedFiles }}
					components={{ count: <strong /> }}
				/>
			</p>
			{rewrittenUrls !== undefined && updatedContentItems !== undefined && (
				<p>
					<Trans
						id="{rewrittenUrls, plural, one {<rewrittenCount>#</rewrittenCount> image URL updated in {updatedContentItems, plural, one {<contentCount>#</contentCount> content item} other {<contentCount>#</contentCount> content items}}} other {<rewrittenCount>#</rewrittenCount> image URLs updated in {updatedContentItems, plural, one {<contentCount>#</contentCount> content item} other {<contentCount>#</contentCount> content items}}}}"
						values={{ rewrittenUrls, updatedContentItems }}
						components={{ rewrittenCount: <strong />, contentCount: <strong /> }}
					/>
				</p>
			)}
		</>
	);
}
