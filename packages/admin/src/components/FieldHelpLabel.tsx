import { Button, Label, Tooltip } from "@cloudflare/kumo";
import { Info } from "@phosphor-icons/react";
import { useState, type ComponentProps, type ReactNode } from "react";

export function FieldHelpLabel({
	children,
	help,
	helpLabel,
	htmlFor,
	labelClassName = "text-base font-medium text-kumo-default",
	side,
	buttonSize = "xs",
	openOnPress = false,
}: {
	children: ReactNode;
	help: ReactNode;
	helpLabel: string;
	htmlFor?: string;
	labelClassName?: string;
	side?: ComponentProps<typeof Tooltip>["side"];
	buttonSize?: ComponentProps<typeof Button>["size"];
	openOnPress?: boolean;
}) {
	const [tooltipOpen, setTooltipOpen] = useState(false);
	return (
		<div className="flex items-center gap-1.5">
			<Label htmlFor={htmlFor} className={labelClassName}>
				{children}
			</Label>
			<Tooltip
				content={help}
				side={side}
				open={openOnPress ? tooltipOpen : undefined}
				onOpenChange={openOnPress ? setTooltipOpen : undefined}
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
						onClick={openOnPress ? () => setTooltipOpen((open) => !open) : undefined}
					/>
				}
			/>
		</div>
	);
}
