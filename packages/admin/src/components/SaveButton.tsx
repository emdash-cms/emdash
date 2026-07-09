/**
 * Save Button with inline progress feedback
 *
 * The saved/dirty state is reported by a passive status indicator. This
 * component always reads as an action so clean editors don't show duplicate
 * "Saved" labels in both status text and disabled buttons.
 */

import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { FloppyDisk } from "@phosphor-icons/react";
import type { ComponentProps } from "react";
import * as React from "react";

import { cn } from "../lib/utils";

export interface SaveButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "shape"> {
	/** Whether there are unsaved changes */
	isDirty: boolean;
	/** Whether currently saving */
	isSaving: boolean;
}

/**
 * Button that reflects whether saving is currently in progress.
 */
export function SaveButton({ isDirty, isSaving, className, disabled, ...props }: SaveButtonProps) {
	const { t } = useLingui();
	const isSaved = !isDirty && !isSaving;

	return (
		<Button
			className={cn("min-w-[100px] transition-all", className)}
			disabled={disabled || isSaving || isSaved}
			variant={isSaved ? "secondary" : "primary"}
			icon={isSaving ? <Loader size="sm" /> : <FloppyDisk />}
			aria-live="polite"
			aria-busy={isSaving}
			{...props}
		>
			{isSaving ? t`Saving...` : t`Save`}
		</Button>
	);
}

export default SaveButton;
