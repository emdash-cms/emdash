/**
 * Reusable confirmation dialog with inline error display.
 *
 * Handles the common pattern: title, description, optional error banner,
 * cancel/confirm buttons with pending state. Dialog stays open on error.
 */

import { LayerDialog } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useConfirmPress } from "../lib/dialog-form.js";
import { useStableCallback } from "../lib/hooks.js";
import { DialogError, getMutationError } from "./DialogError.js";

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
	/**
	 * The action can be reversed afterwards, such as content moved to the trash, a demoted user who
	 * can be promoted again, or a draft that stays in Revisions. The dialog then opens on the confirm
	 * button, so Enter confirms. Leave it off for anything permanent: the dialog opens on Cancel.
	 */
	undoable?: boolean;
	/**
	 * The button that opens the dialog, with the onClick that sets `open`. It renders as the dialog's
	 * trigger, so it announces the dialog and gets focus back when the dialog closes.
	 */
	trigger?: React.ReactElement;
}

type InitialFocus = "confirm" | "cancel";

function useConfirmKeyboard(
	open: boolean,
	initialFocus: InitialFocus,
): React.RefCallback<HTMLElement> {
	const awaitingFirstFocus = React.useRef(open);
	const wasOpen = React.useRef(open);
	React.useLayoutEffect(() => {
		if (open === wasOpen.current) return;
		wasOpen.current = open;
		awaitingFirstFocus.current = open;
	}, [open]);
	const currentInitialFocus = useStableCallback(() => initialFocus);

	return React.useCallback(
		(body: HTMLElement | null) => {
			const popup = body?.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]');
			if (!popup) return;
			if (popup.contains(popup.ownerDocument.activeElement)) awaitingFirstFocus.current = false;

			// Focusing a button while the popup mounts would make Base UI return focus to that button
			// on close instead of the opener, so this waits for Base UI to focus the popup itself.
			const focusInitialButton = (event: FocusEvent) => {
				if (!awaitingFirstFocus.current) return;
				awaitingFirstFocus.current = false;
				if (event.target !== popup) return;
				initialFocusButton(popup, currentInitialFocus())?.focus({ preventScroll: true });
			};
			const blockHeldEnter = (event: KeyboardEvent) => {
				if (event.key === "Enter" && event.repeat && event.target instanceof HTMLButtonElement) {
					event.preventDefault();
				}
			};
			popup.addEventListener("focusin", focusInitialButton);
			popup.addEventListener("keydown", blockHeldEnter, true);
			return () => {
				popup.removeEventListener("focusin", focusInitialButton);
				popup.removeEventListener("keydown", blockHeldEnter, true);
			};
		},
		[currentInitialFocus],
	);
}

function initialFocusButton(
	popup: HTMLElement,
	initialFocus: InitialFocus,
): HTMLButtonElement | null {
	const confirm = popup.querySelector("[data-confirm-action]");
	// LayerDialog.Actions renders its Cancel button, which takes no ref, just before the action.
	const button = initialFocus === "confirm" ? confirm : confirm?.previousElementSibling;
	return button instanceof HTMLButtonElement && !button.disabled ? button : null;
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
	undoable = false,
	trigger,
}: ConfirmDialogProps) {
	const { t } = useLingui();
	const confirm = useConfirmPress(onConfirm, isPending, error);
	const keyboardRef = useConfirmKeyboard(open, undoable ? "confirm" : "cancel");
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
			{trigger && <LayerDialog.Trigger render={trigger} />}
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
					<div ref={keyboardRef} className="grid gap-3">
						{children}
						<DialogError message={error === staleError ? null : getMutationError(error)} />
					</div>
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={cancelLabel ?? t`Cancel`}>
					<LayerDialog.Action
						data-confirm-action=""
						variant={variant}
						disabled={isPending || confirmDisabled}
						onClick={() => confirm()}
					>
						{isPending ? pendingLabel : confirmLabel}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</Root>
	);
}
