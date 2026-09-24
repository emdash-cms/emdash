import { Button, Label, Tooltip } from "@cloudflare/kumo";
import { Info } from "@phosphor-icons/react";
import type { ComponentProps, ReactNode } from "react";

export function FieldHelpLabel({
	children,
	help,
	helpLabel,
	htmlFor,
	labelClassName = "text-base font-medium text-kumo-default",
	side,
	buttonSize = "xs",
}: {
	children: ReactNode;
	help: ReactNode;
	helpLabel: string;
	htmlFor?: string;
	labelClassName?: string;
	side?: ComponentProps<typeof Tooltip>["side"];
	buttonSize?: ComponentProps<typeof Button>["size"];
}) {
	return (
		<div className="flex items-center gap-1.5">
			<Label htmlFor={htmlFor} className={labelClassName}>
				{children}
			</Label>
			<Tooltip
				content={help}
				side={side}
				delay={0}
				closeDelay={0}
				render={
					<Button
						type="button"
						variant="ghost"
						shape="square"
						size={buttonSize}
						icon={<Info aria-hidden="true" />}
						className="text-kumo-subtle hover:text-kumo-default"
						aria-label={helpLabel}
					/>
				}
			/>
		</div>
	);
}
