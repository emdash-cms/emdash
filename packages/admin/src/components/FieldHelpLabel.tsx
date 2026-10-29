import { Button, Label, Tooltip } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Info } from "@phosphor-icons/react";
import { useId, useState, type ComponentProps, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function HelpTooltip({
	help,
	ariaLabel,
	side,
	size = "xs",
	openOnPress = true,
}: {
	help: ReactNode;
	ariaLabel: string;
	side?: ComponentProps<typeof Tooltip>["side"];
	size?: ComponentProps<typeof Button>["size"];
	openOnPress?: boolean;
}) {
	const nameId = useId();
	const [open, setOpen] = useState(false);
	// A press pins the tooltip open. On a touch screen the hover that the tap
	// emulates ends at once and would close it again.
	const [pinned, setPinned] = useState(false);
	return (
		<>
			<Tooltip
				content={
					<span dir="auto" className="block max-w-64 text-pretty">
						{help}
					</span>
				}
				side={side}
				open={openOnPress ? open : undefined}
				onOpenChange={
					openOnPress
						? (nextOpen, details) => {
								// The button's click handler owns presses. Base UI's own close on a
								// trigger press would run after it and undo the pin.
								if (details.reason === "trigger-press") return;
								if (!nextOpen && pinned && details.reason === "trigger-hover") return;
								if (!nextOpen) setPinned(false);
								setOpen(nextOpen);
							}
						: undefined
				}
				delay={0}
				closeDelay={0}
				render={
					<Button
						type="button"
						variant="ghost"
						shape="square"
						size={size}
						icon={<Info aria-hidden="true" />}
						className="text-kumo-subtle hover:text-kumo-default"
						aria-labelledby={nameId}
						onClick={
							openOnPress
								? () => {
										setPinned(!pinned);
										setOpen(!pinned);
									}
								: undefined
						}
					/>
				}
			/>
			{/* Inside a field's label, a name from aria-label would also join the
			    field's name, and hidden text in the label would join its label text,
			    so the name lives outside the label. */}
			{createPortal(
				<span id={nameId} hidden>
					{ariaLabel}
				</span>,
				document.body,
			)}
		</>
	);
}

/**
 * A Kumo field's `label` with a help button after the text. Kumo names a
 * Select or Switch from its label only when the label is a string, so give
 * the control an `aria-label` with the same text.
 */
export function HelpLabel({ children: label, help }: { children: string; help: ReactNode }) {
	const { t } = useLingui();
	return (
		<span className="inline-flex items-center gap-1.5">
			{label}
			<HelpTooltip help={help} ariaLabel={t`More information about ${label}`} />
		</span>
	);
}

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
	return (
		<div className="flex items-center gap-1.5">
			<Label htmlFor={htmlFor} className={labelClassName}>
				{children}
			</Label>
			<HelpTooltip
				help={help}
				ariaLabel={helpLabel}
				side={side}
				size={buttonSize}
				openOnPress={openOnPress}
			/>
		</div>
	);
}
