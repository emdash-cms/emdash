import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, FloppyDisk } from "@phosphor-icons/react";
import { isValidElement, useEffect, useRef, useState } from "react";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

type SaveState = "save" | "saving" | "saved";

const TEXT_SWAP_DURATION_MS = 150;

export interface SaveButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "shape"> {
	isDirty: boolean;
	isSaving: boolean;
	announce?: boolean;
}

export function SaveButton({
	isDirty,
	isSaving,
	announce = true,
	className,
	disabled,
	icon,
	loading,
	variant,
	"aria-label": ariaLabel,
	...props
}: SaveButtonProps) {
	const { t } = useLingui();
	const saveLabel = t`Save`;
	const savingLabel = t`Saving...`;
	const savedLabel = t`Saved`;
	const isBusy = isSaving || Boolean(loading);
	const activeState: SaveState = isBusy ? "saving" : isDirty ? "save" : "saved";
	const activeLabel =
		activeState === "save" ? saveLabel : activeState === "saving" ? savingLabel : savedLabel;
	const states = [
		{ id: "save", label: saveLabel },
		{ id: "saving", label: savingLabel },
		{ id: "saved", label: savedLabel },
	] as const;
	const [displayedState, setDisplayedState] = useState<SaveState>(activeState);
	const [swapPhase, setSwapPhase] = useState<"idle" | "exit" | "enter-start">("idle");
	const displayedStateRef = useRef(displayedState);
	const textRef = useRef<HTMLSpanElement>(null);
	const displayedLabel =
		displayedState === "save" ? saveLabel : displayedState === "saving" ? savingLabel : savedLabel;
	const displayedIcon =
		displayedState === "save" ? (
			isValidElement(icon) ? (
				icon
			) : (
				<FloppyDisk />
			)
		) : displayedState === "saving" ? (
			<Loader size="sm" />
		) : (
			<Check />
		);

	useEffect(() => {
		let animationFrame = 0;

		if (activeState === displayedStateRef.current) {
			setSwapPhase("idle");
			return;
		}

		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			displayedStateRef.current = activeState;
			setDisplayedState(activeState);
			setSwapPhase("idle");
			return;
		}

		setSwapPhase("exit");
		const timeout = window.setTimeout(() => {
			displayedStateRef.current = activeState;
			setDisplayedState(activeState);
			setSwapPhase("enter-start");
			animationFrame = window.requestAnimationFrame(() => {
				void textRef.current?.offsetWidth;
				setSwapPhase("idle");
			});
		}, TEXT_SWAP_DURATION_MS);

		return () => {
			window.clearTimeout(timeout);
			window.cancelAnimationFrame(animationFrame);
		};
	}, [activeState]);

	return (
		<Button
			{...props}
			className={cn("min-w-[100px] justify-center", className)}
			disabled={disabled || !isDirty || isBusy}
			variant={variant ?? (isDirty || isBusy ? "primary" : "secondary")}
			aria-label={ariaLabel ?? activeLabel}
			aria-busy={isBusy}
		>
			<span
				data-save-button-labels=""
				className="overflow-hidden"
				style={{ display: "inline-grid", alignItems: "center", justifyItems: "center" }}
				aria-hidden="true"
			>
				{states.map((state) => (
					<span
						key={state.id}
						data-save-button-state={state.id}
						style={{ gridArea: "1 / 1", visibility: "hidden" }}
						className="inline-flex items-center justify-center gap-1.5"
					>
						<span style={{ width: 16, height: 16 }} />
						{state.label}
					</span>
				))}
				<span
					ref={textRef}
					data-save-button-visible-state={displayedState}
					style={{ gridArea: "1 / 1" }}
					className={cn(
						"t-text-swap",
						swapPhase === "exit" && "is-exit",
						swapPhase === "enter-start" && "is-enter-start",
					)}
				>
					<span className="flex items-center justify-center gap-1.5 leading-none">
						{displayedIcon}
						{displayedLabel}
					</span>
				</span>
			</span>
			<span
				className="sr-only"
				role={announce ? "status" : undefined}
				aria-live={announce ? "polite" : undefined}
				aria-atomic={announce || undefined}
			>
				{activeLabel}
			</span>
		</Button>
	);
}

export default SaveButton;
