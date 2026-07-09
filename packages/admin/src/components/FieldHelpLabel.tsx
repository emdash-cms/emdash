import { Label, Tooltip } from "@cloudflare/kumo";
import { Info } from "@phosphor-icons/react";
import type { ReactNode } from "react";

export function FieldHelpLabel({
	children,
	help,
	helpLabel,
	htmlFor,
}: {
	children: ReactNode;
	help: ReactNode;
	helpLabel: string;
	htmlFor?: string;
}) {
	return (
		<div className="flex items-center gap-1.5">
			<Label htmlFor={htmlFor} className="text-sm font-medium text-kumo-default">
				{children}
			</Label>
			<Tooltip
				content={help}
				delay={0}
				closeDelay={0}
				render={
					<button
						type="button"
						className="inline-flex cursor-help rounded-full text-kumo-subtle hover:text-kumo-default focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
						aria-label={helpLabel}
					>
						<Info className="h-4 w-4" aria-hidden="true" />
					</button>
				}
			/>
		</div>
	);
}
