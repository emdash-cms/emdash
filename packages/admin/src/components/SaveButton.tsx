/**
 * Save Button with inline feedback
 *
 * Shows state based on whether there are unsaved changes:
 * - "Saved" when clean (no unsaved changes)
 * - "Save" when dirty (has unsaved changes)
 * - "Saving..." while saving
 */

import { Button, Loader } from "@cloudflare/kumo";
import { FloppyDisk, Check } from "@phosphor-icons/react";
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
 * Button that reflects save state
 */
export function SaveButton({ isDirty, isSaving, className, disabled, ...props }: SaveButtonProps) {
	const isSaved = !isDirty && !isSaving;

	return (
		<Button
			className={cn("transition-all", className)}
			disabled={disabled || isSaving || isSaved}
			variant={isSaved ? "secondary" : "primary"}
			icon={isSaving ? <Loader size="sm" /> : isSaved ? <Check /> : <FloppyDisk />}
			aria-live="polite"
			aria-busy={isSaving}
			{...props}
		>
			{isSaving ? "Saving..." : isSaved ? "Saved" : "Save"}
		</Button>
	);
}

export default SaveButton;
