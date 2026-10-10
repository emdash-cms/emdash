import { Button, Dialog, DialogRoot } from "@cloudflare/kumo";
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

	const fireAction = useCallback(() => {
		onAction({
			type: "block_action",
			action_id: element.action_id,
			value: element.value,
		});
	}, [onAction, element.action_id, element.value]);

	const handleClick = useCallback(() => {
		if (element.confirm) {
			setConfirmOpen(true);
		} else {
			fireAction();
		}
	}, [element.confirm, fireAction]);

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

	return (
		<>
			<Button variant={variant} onClick={handleClick}>
				{element.label}
			</Button>
			{element.confirm && (
				<DialogRoot open={confirmOpen} onOpenChange={setConfirmOpen}>
					<Dialog className="p-6" size="sm">
						<Dialog.Title dir="auto" className="text-lg font-semibold">
							{element.confirm.title}
						</Dialog.Title>
						<Dialog.Description dir="auto" className="text-kumo-subtle">
							{element.confirm.text}
						</Dialog.Description>
						<div className="mt-6 flex justify-end gap-2">
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
