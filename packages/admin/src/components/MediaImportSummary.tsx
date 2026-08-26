import { msg } from "@lingui/core/macro";
import { Trans } from "@lingui/react";
import * as React from "react";

// The alias prevents Lingui from treating the runtime renderer as a macro
// <Trans> and reporting "Missing message ID"; msg descriptors handle extraction.
const DescriptorMessage = Trans;

const importedFilesMessage = msg`{importedFiles, plural, one {<count>#</count> file imported} other {<count>#</count> files imported}}`;

const updatedUrlsMessage = msg`{rewrittenUrls, plural, one {<rewrittenCount>#</rewrittenCount> image URL updated in {updatedContentItems, plural, one {<contentCount>#</contentCount> content item} other {<contentCount>#</contentCount> content items}}} other {<rewrittenCount>#</rewrittenCount> image URLs updated in {updatedContentItems, plural, one {<contentCount>#</contentCount> content item} other {<contentCount>#</contentCount> content items}}}}`;

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
