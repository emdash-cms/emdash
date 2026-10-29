/**
 * Reusable confirmation dialog with inline error display.
 *
 * Handles the common pattern: title, description, optional error banner,
 * cancel/confirm buttons with pending state. Dialog stays open on error.
 */

import { LayerDialog, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

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
	/** Prevent dismissing an irreversible request after it has started. */
	preventCloseWhilePending?: boolean;
	/** Disable confirmation until required input in the dialog is complete. */
	confirmDisabled?: boolean;
	isPending: boolean;
	/** Error from a mutation — pass mutation.error directly */
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
	preventCloseWhilePending = false,
	confirmDisabled = false,
	isPending,
	error,
	onConfirm,
	children,
}: ConfirmDialogProps) {
	const { t } = useLingui();
	const closeLocked = preventCloseWhilePending && isPending;
	const Root = role === "alertdialog" ? LayerDialog.Alert : LayerDialog.Root;
	return (
		<Root
			open={open}
			onOpenChange={(nextOpen) => !nextOpen && !closeLocked && onClose()}
			dismissDisabled={closeLocked}
			disablePointerDismissal
		>
			<LayerDialog.Content size="sm">
				<LayerDialog.Title>
					<span dir="auto" className="block">
						{title}
					</span>
				</LayerDialog.Title>
				<LayerDialog.Body>
					<Text variant="secondary" dir="auto">
						{description}
					</Text>
					{children}
					<DialogError message={getMutationError(error)} className="mt-3" />
				</LayerDialog.Body>
				<LayerDialog.Actions dismissLabel={cancelLabel ?? t`Cancel`}>
					<LayerDialog.Action
						variant={variant}
						disabled={isPending || confirmDisabled}
						onClick={onConfirm}
					>
						{isPending ? pendingLabel : confirmLabel}
					</LayerDialog.Action>
				</LayerDialog.Actions>
			</LayerDialog.Content>
		</Root>
	);
}
