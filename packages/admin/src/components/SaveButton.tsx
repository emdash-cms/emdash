/**
 * Save Button with inline feedback
 *
 * A single stateful control that reports save progress without becoming a
 * sticky status label:
 * - "Save" when clean or dirty (disabled when clean)
 * - "Saving..." while saving (manual save or autosave)
 * - "Saved" briefly after saving completes
 */

import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { FloppyDisk, Check } from "@phosphor-icons/react";
import type { ComponentProps } from "react";
import * as React from "react";

import { cn } from "../lib/utils";

const SAVED_FEEDBACK_MS = 1200;

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
	const [showSavedFeedback, setShowSavedFeedback] = React.useState(false);
	const wasDirtyRef = React.useRef(isDirty);
	const wasSavingRef = React.useRef(isSaving);

	React.useEffect(() => {
		const wasDirty = wasDirtyRef.current;
		const wasSaving = wasSavingRef.current;
		wasDirtyRef.current = isDirty;
		wasSavingRef.current = isSaving;

		if (isDirty || isSaving) {
			setShowSavedFeedback(false);
			return;
		}

		if (wasDirty || wasSaving) {
			setShowSavedFeedback(true);
			const timeout = globalThis.setTimeout(setShowSavedFeedback, SAVED_FEEDBACK_MS, false);
			return () => globalThis.clearTimeout(timeout);
		}
	}, [isDirty, isSaving]);

	const isClean = !isDirty && !isSaving;
	const isComplete = isClean && showSavedFeedback;
	const label = isSaving ? t`Saving...` : isComplete ? t`Saved` : t`Save`;
	const liveStatus = isSaving ? t`Saving...` : isComplete ? t`Saved` : "";

	return (
		<>
			<Button
				className={cn("min-w-[100px] transition-all", className)}
				disabled={disabled || isSaving || isClean}
				variant={isDirty || isSaving ? "primary" : "secondary"}
				icon={isSaving ? <Loader size="sm" /> : isComplete ? <Check /> : <FloppyDisk />}
				aria-busy={isSaving}
				{...props}
			>
				{label}
			</Button>
			<span className="sr-only" role="status" aria-live="polite">
				{liveStatus}
			</span>
		</>
	);
}

export default SaveButton;
