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
import type { ComponentProps, CSSProperties } from "react";
import * as React from "react";

import { cn } from "../lib/utils";

const SAVED_FEEDBACK_MS = 1200;
const BUTTON_TRANSITION =
	"background-color 160ms cubic-bezier(0.23, 1, 0.32, 1), border-color 160ms cubic-bezier(0.23, 1, 0.32, 1), color 160ms cubic-bezier(0.23, 1, 0.32, 1), box-shadow 160ms cubic-bezier(0.23, 1, 0.32, 1)";
const CONTENT_TRANSITION =
	"opacity 160ms cubic-bezier(0.23, 1, 0.32, 1), filter 160ms cubic-bezier(0.23, 1, 0.32, 1), transform 160ms cubic-bezier(0.23, 1, 0.32, 1)";
const REDUCED_MOTION_TRANSITION = "opacity 120ms ease-out";

type SaveButtonVisualState = "idle" | "saving" | "saved";

export interface SaveButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "shape"> {
	/** Whether there are unsaved changes */
	isDirty: boolean;
	/** Whether currently saving */
	isSaving: boolean;
}

function usePrefersReducedMotion() {
	const [prefersReducedMotion, setPrefersReducedMotion] = React.useState(false);

	React.useEffect(() => {
		if (typeof window === "undefined") return;

		const mediaQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
		const updatePreference = () => setPrefersReducedMotion(mediaQuery.matches);
		updatePreference();
		mediaQuery.addEventListener("change", updatePreference);
		return () => mediaQuery.removeEventListener("change", updatePreference);
	}, []);

	return prefersReducedMotion;
}

function getSlotStyle(
	state: SaveButtonVisualState,
	activeState: SaveButtonVisualState,
	prefersReducedMotion: boolean,
): CSSProperties {
	const isActive = state === activeState;
	return {
		display: "inline-flex",
		gridArea: "stack",
		alignItems: "center",
		justifyContent: "center",
		gap: "0.375rem",
		opacity: isActive ? 1 : 0,
		filter: isActive || prefersReducedMotion ? "blur(0)" : "blur(1.25px)",
		pointerEvents: "none",
		transform:
			isActive || prefersReducedMotion ? "translateY(0) scale(1)" : "translateY(-1px) scale(0.985)",
		transition: prefersReducedMotion ? REDUCED_MOTION_TRANSITION : CONTENT_TRANSITION,
		whiteSpace: "nowrap",
		willChange: prefersReducedMotion ? "opacity" : "opacity, filter, transform",
	};
}

/**
 * Button that reflects whether saving is currently in progress.
 */
export function SaveButton({
	isDirty,
	isSaving,
	className,
	disabled,
	style,
	...props
}: SaveButtonProps) {
	const { t } = useLingui();
	const prefersReducedMotion = usePrefersReducedMotion();
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
	const visualState: SaveButtonVisualState = isSaving ? "saving" : isComplete ? "saved" : "idle";
	const label = isSaving ? t`Saving...` : isComplete ? t`Saved` : t`Save`;
	const liveStatus = isSaving ? t`Saving...` : isComplete ? t`Saved` : "";
	const contentStyle: CSSProperties = {
		display: "inline-grid",
		gridTemplateAreas: '"stack"',
		minInlineSize: "4.75rem",
		placeItems: "center",
	};

	return (
		<>
			<Button
				className={cn("min-w-[100px]", className)}
				disabled={disabled || isSaving || isClean}
				variant={isDirty || isSaving ? "primary" : "secondary"}
				aria-label={props["aria-label"] ?? label}
				aria-busy={isSaving}
				style={{ transition: BUTTON_TRANSITION, ...style }}
				{...props}
			>
				<span style={contentStyle}>
					<span aria-hidden="true" style={getSlotStyle("idle", visualState, prefersReducedMotion)}>
						<FloppyDisk />
						<span>{t`Save`}</span>
					</span>
					<span
						aria-hidden="true"
						style={getSlotStyle("saving", visualState, prefersReducedMotion)}
					>
						<Loader size="sm" />
						<span>{t`Saving...`}</span>
					</span>
					<span aria-hidden="true" style={getSlotStyle("saved", visualState, prefersReducedMotion)}>
						<Check />
						<span>{t`Saved`}</span>
					</span>
				</span>
			</Button>
			<span className="sr-only" role="status" aria-live="polite">
				{liveStatus}
			</span>
		</>
	);
}

export default SaveButton;
