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
						id="{rewrittenUrls, plural, one {<urlCount>#</urlCount> image URL updated in {updatedContentItems, plural, one {<itemCount>#</itemCount> content item} other {<itemCount>#</itemCount> content items}}} other {<urlCount>#</urlCount> image URLs updated in {updatedContentItems, plural, one {<itemCount>#</itemCount> content item} other {<itemCount>#</itemCount> content items}}}}"
						values={{ rewrittenUrls, updatedContentItems }}
						components={{ urlCount: <strong />, itemCount: <strong /> }}
					/>
				</p>
			)}
		</>
	);
}
