import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react";
import * as React from "react";

const DescriptorMessage = Trans;

const importedFilesMessage = msg({
	message:
		"{importedFiles, plural, one {<count>#</count> file imported} other {<count>#</count> files imported}}",
});

const updatedUrlsMessage = msg({
	message:
		"{rewrittenUrls, plural, one {<rewrittenCount>#</rewrittenCount> image URL updated in {updatedContentItems, plural, one {<contentCount>#</contentCount> content item} other {<contentCount>#</contentCount> content items}}} other {<rewrittenCount>#</rewrittenCount> image URLs updated in {updatedContentItems, plural, one {<contentCount>#</contentCount> content item} other {<contentCount>#</contentCount> content items}}}}",
});

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
				<DescriptorMessage
					{...importedFilesMessage}
					values={{ importedFiles }}
					components={{ count: <strong /> }}
				/>
			</p>
			{rewrittenUrls !== undefined && updatedContentItems !== undefined && (
				<p>
					<DescriptorMessage
						{...updatedUrlsMessage}
						values={{ rewrittenUrls, updatedContentItems }}
						components={{ rewrittenCount: <strong />, contentCount: <strong /> }}
					/>
				</p>
			)}
		</>
	);
}
