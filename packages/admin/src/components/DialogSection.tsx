import { useLingui } from "@lingui/react/macro";
import type * as React from "react";

import { HelpTooltip } from "./FieldHelpLabel.js";

export interface DialogSectionProps {
	title: string;
	description?: React.ReactNode;
	help?: React.ReactNode;
	action?: React.ReactNode;
	children?: React.ReactNode;
}

export function DialogSection({
	title: label,
	description,
	help,
	action,
	children,
}: DialogSectionProps) {
	const { t } = useLingui();
	return (
		<div className="grid gap-4 border-t border-kumo-line pt-5 first:border-t-0 first:pt-0">
			<div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
				<div className="grid min-w-0 flex-1 basis-56 gap-1">
					<div className="flex items-center gap-1.5">
						<h3 className="text-base font-semibold text-kumo-default">{label}</h3>
						{help && <HelpTooltip help={help} ariaLabel={t`More information about ${label}`} />}
					</div>
					{description && <p className="text-sm text-pretty text-kumo-subtle">{description}</p>}
				</div>
				{action}
			</div>
			{children}
		</div>
	);
}
