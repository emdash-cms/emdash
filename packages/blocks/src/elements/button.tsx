import { Button, Dialog, DialogRoot, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import { useCallback, useState } from "react";

import type { BlockInteraction, ButtonElement } from "../types.js";

export function ButtonElementComponent({
	element,
	onAction,
}: {
	element: ButtonElement;
	onAction: (interaction: BlockInteraction) => void;
}) {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const isDisabled = element.disabled === true;
	const hasTitle = element.title !== undefined && element.title.length > 0;

	const fireAction = useCallback(() => {
		if (isDisabled) return;
		onAction({
			type: "block_action",
			action_id: element.action_id,
			value: element.value,
		});
	}, [onAction, isDisabled, element.action_id, element.value]);

	const handleClick = useCallback(() => {
		if (isDisabled) return;
		if (element.confirm) {
			setConfirmOpen(true);
		} else {
			fireAction();
		}
	}, [isDisabled, element.confirm, fireAction]);

	const handleConfirm = useCallback(() => {
		setConfirmOpen(false);
		fireAction();
	}, [fireAction]);

	const variant =
		element.style === "primary"
			? ("primary" as const)
			: element.style === "danger"
				? ("destructive" as const)
				: ("secondary" as const);

	// Don't pass `title` into Kumo Button when disabled — that attaches the
	// tooltip trigger to the disabled <button>, which never receives hover.
	// Instead wrap a span (always hoverable) as the Tooltip trigger.
	const button = (
		<Button variant={variant} onClick={handleClick} disabled={isDisabled}>
			{element.label}
		</Button>
	);

	const withTooltip = hasTitle ? (
		<TooltipProvider>
			<Tooltip
				content={element.title}
				delay={200}
				closeDelay={0}
				// Span keeps pointer events when the inner button is disabled.
				render={<span className="inline-flex max-w-max" />}
			>
				{button}
			</Tooltip>
		</TooltipProvider>
	) : (
		button
	);

	return (
		<>
			{withTooltip}
			{element.confirm && !isDisabled && (
				<DialogRoot open={confirmOpen} onOpenChange={setConfirmOpen}>
					<Dialog>
						<h3 className="text-lg font-semibold text-kumo-default">{element.confirm.title}</h3>
						<p className="mt-1 text-sm text-kumo-subtle">{element.confirm.text}</p>
						<div className="flex justify-end gap-2 pt-4">
							<Button variant="secondary" onClick={() => setConfirmOpen(false)}>
								{element.confirm.deny}
							</Button>
							<Button
								variant={element.confirm.style === "danger" ? "destructive" : "primary"}
								onClick={handleConfirm}
							>
								{element.confirm.confirm}
							</Button>
						</div>
					</Dialog>
				</DialogRoot>
			)}
		</>
	);
}
