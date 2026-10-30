/**
 * Reusable confirmation dialog with inline error display.
 *
 * Handles the common pattern: title, description, optional error banner,
 * cancel/confirm buttons with pending state. Dialog stays open on error.
 */

import { LayerDialog } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { DialogError, getMutationError } from "./DialogError.js";

/** Both clicks of a double click can land before `isPending` renders. */
const DOUBLE_PRESS_MS = 500;

export interface ConfirmDialogProps {
	open: boolean;
	onClose: () => void;
	/** ARIA role; use alertdialog for destructive actions requiring acknowledgment. */
	role?: "dialog" | "alertdialog";
	title: string;
	/** Static description or inline JSX; it renders inside a paragraph. */
	description: React.ReactNode;
	/** Label for the confirm button (e.g. "Delete", "Disable User") */
	confirmLabel: string;
	/** Optional cancel label; defaults to the localized host label. */
	cancelLabel?: string;
	/** Label shown while the action is pending (e.g. "Deleting...") */
	pendingLabel: string;
	/** Button variant — defaults to "destructive" */
	variant?: "destructive" | "primary";
	/** Disable confirmation until required input in the dialog is complete. */
	confirmDisabled?: boolean;
	isPending: boolean;
	/** Error from a mutation — pass mutation.error directly. An error already
	 * there when the dialog opens came from an earlier request and is not shown. */
	error: unknown;
	onConfirm: () => void;
	/** Extra content rendered between description and buttons (e.g. a checkbox) */
	children?: React.ReactNode;
}

export function ConfirmDialog({
	open,
	onClose,
	role = "dialog",
	title,
	description,
	confirmLabel,
	cancelLabel,
	pendingLabel,
	variant = "destructive",
	confirmDisabled = false,
	isPending,
	error,
	onConfirm,
	children,
}: ConfirmDialogProps) {
	const { t } = useLingui();
	const lastPressRef = React.useRef(Number.NEGATIVE_INFINITY);
	// A failure can be retried at once.
	React.useEffect(() => {
		if (error) lastPressRef.current = Number.NEGATIVE_INFINITY;
	}, [error]);
	const confirm = () => {
		const now = performance.now();
		if (isPending || now - lastPressRef.current < DOUBLE_PRESS_MS) return;
		lastPressRef.current = now;
		onConfirm();
	};
	// A mutation shared by several items still holds the last item's failure.
	const [staleError, setStaleError] = React.useState(() => (open ? error : null));
	const [wasOpen, setWasOpen] = React.useState(open);
	if (open !== wasOpen) {
		setWasOpen(open);
		if (open) setStaleError(error);
	}
	const Root = role === "alertdialog" ? LayerDialog.Alert : LayerDialog.Root;
	return (
		<Root
			open={open}
			onOpenChange={(nextOpen) => !nextOpen && !isPending && onClose()}
			dismissDisabled={isPending}
			disablePointerDismissal
		>
			<LayerDialog.Content size="sm">
				<LayerDialog.Title>
					<span dir="auto" className="block">
						{title}
					</span>
				</LayerDialog.Title>
				<LayerDialog.Description>
					<span dir="auto" className="block">
						{description}
					</span>
				</LayerDialog.Description>
				<LayerDialog.Body>
					<div className="grid gap-3">
						{children}
						<DialogError message={error === staleError ? null : getMutationError(error)} />
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={cancelLabel ?? t`Cancel`}>
					<LayerDialog.Action
						variant={variant}
						disabled={isPending || confirmDisabled}
						onClick={confirm}
					>
						{isPending ? pendingLabel : confirmLabel}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</Root>
	);
}
