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
