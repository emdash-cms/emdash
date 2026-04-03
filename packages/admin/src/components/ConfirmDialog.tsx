/**
 * Reusable confirmation dialog with inline error display.
 *
 * Handles the common pattern: title, description, optional error banner,
 * cancel/confirm buttons with pending state. Dialog stays open on error.
 */

import { Button, Dialog } from "@cloudflare/kumo";
import * as React from "react";

import { useTranslation } from "../i18n/index.js";
import { DialogError, getMutationError } from "./DialogError.js";

export interface ConfirmDialogProps {
	open: boolean;
	onClose: () => void;
	title: string;
	/** Static description or dynamic JSX content */
	description: React.ReactNode;
	/** Label for the confirm button (e.g. "Delete", "Disable User") */
	confirmLabel: string;
	/** Label shown while the action is pending (e.g. "Deleting...") */
	pendingLabel: string;
	/** Button variant — defaults to "destructive" */
	variant?: "destructive" | "primary";
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
	title,
	description,
	confirmLabel,
	pendingLabel,
	variant = "destructive",
	isPending,
	error,
	onConfirm,
	children,
}: ConfirmDialogProps) {
	const { t } = useTranslation("common");
	return (
		<Dialog.Root open={open} onOpenChange={(o) => !o && onClose()} disablePointerDismissal>
			<Dialog className="p-6" size="sm">
				<Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Description className="text-kumo-subtle">{description}</Dialog.Description>
				{children}
				<DialogError message={getMutationError(error)} className="mt-3" />
				<div className="mt-6 flex justify-end gap-2">
					<Button variant="secondary" onClick={onClose}>
						{t("cancel")}
					</Button>
					<Button variant={variant} disabled={isPending} onClick={onConfirm}>
						{isPending ? pendingLabel : confirmLabel}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
