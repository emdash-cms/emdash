import { Button, Label, Tooltip } from "@cloudflare/kumo";
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
					<Button
						type="button"
						variant="ghost"
						shape="square"
						size="xs"
						icon={<Info aria-hidden="true" />}
						className="text-kumo-subtle hover:text-kumo-default"
						aria-label={helpLabel}
					/>
				}
			/>
		</div>
	);
}
