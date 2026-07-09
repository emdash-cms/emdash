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

const SAVING_REVEAL_MS = 150;
const MIN_SAVING_VISIBLE_MS = 320;
const SAVED_FEEDBACK_MS = 850;
const SAVE_BUTTON_EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
const BUTTON_TRANSITION = [
	`background-color 200ms ${SAVE_BUTTON_EASE}`,
	`border-color 200ms ${SAVE_BUTTON_EASE}`,
	`color 200ms ${SAVE_BUTTON_EASE}`,
	`box-shadow 200ms ${SAVE_BUTTON_EASE}`,
].join(", ");
const CONTENT_TRANSITION = [
	`opacity 180ms ${SAVE_BUTTON_EASE}`,
	`filter 180ms ${SAVE_BUTTON_EASE}`,
	`transform 180ms ${SAVE_BUTTON_EASE}`,
].join(", ");
const REDUCED_MOTION_TRANSITION = "opacity 140ms ease-out";

type SaveButtonVisualState = "idle" | "saving" | "saved";
type TimeoutRef = { current: ReturnType<typeof globalThis.setTimeout> | null };
type TimeRef = { current: number | null };
type SetVisualState = (state: SaveButtonVisualState) => void;

export interface SaveButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "shape"> {
	/** Whether there are unsaved changes */
	isDirty: boolean;
	/** Whether currently saving */
	isSaving: boolean;
	/** Whether this instance should announce save state changes to assistive tech. */
	announceStatus?: boolean;
	/** Whether the visual saving state should block manual submit. */
	disableWhileSaving?: boolean;
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

function getTime() {
	return typeof globalThis.performance === "undefined" ? Date.now() : globalThis.performance.now();
}

function clearTimeoutRef(timeoutRef: TimeoutRef) {
	if (!timeoutRef.current) return;
	globalThis.clearTimeout(timeoutRef.current);
	timeoutRef.current = null;
}

function revealSavingState(savingShownAtRef: TimeRef, setVisualState: SetVisualState) {
	savingShownAtRef.current = getTime();
	setVisualState("saving");
}

function startSavedPulse(setVisualState: SetVisualState, savedTimeoutRef: TimeoutRef) {
	clearTimeoutRef(savedTimeoutRef);
	setVisualState("saved");
	savedTimeoutRef.current = globalThis.setTimeout(setVisualState, SAVED_FEEDBACK_MS, "idle");
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
		color: state === "saved" ? "var(--text-color-kumo-success)" : undefined,
		justifyContent: "center",
		gap: "0.375rem",
		opacity: isActive ? 1 : 0,
		filter: isActive || prefersReducedMotion ? "blur(0)" : "blur(1.5px)",
		lineHeight: 1,
		pointerEvents: "none",
		transform: isActive || prefersReducedMotion ? "scale(1)" : "scale(0.97)",
		transformOrigin: "center",
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
	announceStatus = true,
	disableWhileSaving,
	className,
	disabled,
	style,
	...props
}: SaveButtonProps) {
	const { t } = useLingui();
	const prefersReducedMotion = usePrefersReducedMotion();
	const [visualState, setVisualState] = React.useState<SaveButtonVisualState>("idle");
	const visualStateRef = React.useRef<SaveButtonVisualState>("idle");
	const wasDirtyRef = React.useRef(isDirty);
	const wasSavingRef = React.useRef(isSaving);
	const savingRevealTimeoutRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(
		null,
	);
	const minSavingTimeoutRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
	const savedTimeoutRef = React.useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
	const savingShownAtRef = React.useRef<number | null>(null);
	const setVisualStateSafely = React.useCallback((state: SaveButtonVisualState) => {
		visualStateRef.current = state;
		setVisualState(state);
	}, []);

	React.useEffect(() => {
		return () => {
			clearTimeoutRef(savingRevealTimeoutRef);
			clearTimeoutRef(minSavingTimeoutRef);
			clearTimeoutRef(savedTimeoutRef);
		};
	}, []);

	React.useEffect(() => {
		const wasDirty = wasDirtyRef.current;
		const wasSaving = wasSavingRef.current;
		wasDirtyRef.current = isDirty;
		wasSavingRef.current = isSaving;

		if (isSaving) {
			clearTimeoutRef(savedTimeoutRef);
			clearTimeoutRef(minSavingTimeoutRef);

			if (visualStateRef.current !== "saving" && !savingRevealTimeoutRef.current) {
				savingRevealTimeoutRef.current = globalThis.setTimeout(
					revealSavingState,
					SAVING_REVEAL_MS,
					savingShownAtRef,
					setVisualStateSafely,
				);
			}
			return;
		}

		clearTimeoutRef(savingRevealTimeoutRef);

		if (isDirty) {
			clearTimeoutRef(minSavingTimeoutRef);
			clearTimeoutRef(savedTimeoutRef);
			savingShownAtRef.current = null;
			setVisualStateSafely("idle");
			return;
		}

		if (wasDirty || wasSaving) {
			const savingShownAt = savingShownAtRef.current;
			savingShownAtRef.current = null;

			if (visualStateRef.current === "saving" && savingShownAt !== null) {
				const remaining = Math.max(MIN_SAVING_VISIBLE_MS - (getTime() - savingShownAt), 0);
				if (remaining > 0) {
					minSavingTimeoutRef.current = globalThis.setTimeout(
						startSavedPulse,
						remaining,
						setVisualStateSafely,
						savedTimeoutRef,
					);
					return;
				}
			}

			startSavedPulse(setVisualStateSafely, savedTimeoutRef);
			return;
		}

		setVisualStateSafely("idle");
	}, [isDirty, isSaving, setVisualStateSafely]);

	const isClean = !isDirty && !isSaving;
	const isVisuallySaving = visualState === "saving";
	const isSavingBlocked = disableWhileSaving ?? isSaving;
	const isDisabled = disabled || isClean || (isSaving && (!isDirty || isSavingBlocked));
	const label =
		visualState === "saving" ? t`Saving...` : visualState === "saved" ? t`Saved` : t`Save`;
	const liveStatus =
		visualState === "saving" ? t`Saving...` : visualState === "saved" ? t`Saved` : "";
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
				disabled={isDisabled}
				variant={isDirty || isSaving || isVisuallySaving ? "primary" : "secondary"}
				aria-label={props["aria-label"] ?? label}
				aria-busy={isSaving || isVisuallySaving}
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
			{announceStatus && (
				<span className="sr-only" role="status" aria-live="polite">
					{liveStatus}
				</span>
			)}
		</>
	);
}

export default SaveButton;
