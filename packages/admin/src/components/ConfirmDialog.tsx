/**
 * Reusable confirmation dialog with inline error display.
 *
 * Handles the common pattern: title, description, optional error banner,
 * cancel/confirm buttons with pending state. Dialog stays open on error.
 */

import { Button, Dialog } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { DialogError, getMutationError } from "./DialogError.js";

export interface ConfirmDialogProps {
	open: boolean;
	onClose: () => void;
	/** ARIA role; use alertdialog for destructive actions requiring acknowledgment. */
	role?: "dialog" | "alertdialog";
	title: string;
	/** Optional typography override for a confirmation with stronger hierarchy. */
	titleClassName?: string;
	/** Static description or dynamic JSX content */
	description: React.ReactNode;
	/** Optional typography override for the primary explanatory copy. */
	descriptionClassName?: string;
	/** Label for the confirm button (e.g. "Delete", "Disable User") */
	confirmLabel: string;
	/** Label shown while the action is pending (e.g. "Deleting...") */
	pendingLabel: string;
	/** Button variant — defaults to "destructive" */
	variant?: "destructive" | "primary";
	/** Use tighter Kumo spacing for short, focused confirmations. */
	compact?: boolean;
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
	titleClassName,
	description,
	descriptionClassName,
	confirmLabel,
	pendingLabel,
	variant = "destructive",
	compact = false,
	preventCloseWhilePending = false,
	confirmDisabled = false,
	isPending,
	error,
	onConfirm,
	children,
}: ConfirmDialogProps) {
	const { t } = useLingui();
	const closeLocked = preventCloseWhilePending && isPending;
	return (
		<Dialog.Root
			role={role}
			open={open}
			onOpenChange={(nextOpen) => !nextOpen && !closeLocked && onClose()}
			disablePointerDismissal
		>
			<Dialog className={compact ? "max-w-md px-5 pt-6 pb-4" : "p-6"} size="sm">
				<div className={compact ? "grid gap-1" : undefined}>
					<Dialog.Title
						className={
							titleClassName ??
							(compact ? "text-lg font-semibold leading-6" : "text-lg font-semibold")
						}
					>
						{title}
					</Dialog.Title>
					<Dialog.Description
						className={
							descriptionClassName ??
							(compact ? "text-sm leading-5 text-pretty text-kumo-subtle" : "text-kumo-subtle")
						}
					>
						{description}
					</Dialog.Description>
				</div>
				{children}
				<DialogError message={getMutationError(error)} className="mt-3" />
				<div className={`${compact ? "mt-5" : "mt-6"} flex justify-end gap-2`}>
					<Button variant="secondary" disabled={closeLocked} onClick={onClose}>
						{t`Cancel`}
					</Button>
					<Button variant={variant} disabled={isPending || confirmDisabled} onClick={onConfirm}>
						{isPending ? pendingLabel : confirmLabel}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
