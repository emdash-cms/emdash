import { Button, Loader } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, FloppyDisk } from "@phosphor-icons/react";
import type { ComponentProps } from "react";

import { cn } from "../lib/utils";

export interface SaveButtonProps extends Omit<ComponentProps<typeof Button>, "children" | "shape"> {
	isDirty: boolean;
	isSaving: boolean;
}

export function SaveButton({
	isDirty,
	isSaving,
	className,
	disabled,
	icon,
	loading,
	variant,
	"aria-label": ariaLabel,
	...props
}: SaveButtonProps) {
	const { t } = useLingui();
	const label = t`Save`;
	const isBusy = isSaving || Boolean(loading);

	return (
		<Button
			{...props}
			className={cn("min-w-[100px]", className)}
			disabled={disabled || !isDirty || isBusy}
			loading={loading}
			variant={variant ?? (isDirty || isBusy ? "primary" : "secondary")}
			icon={
				icon ??
				(isSaving ? (
					<span aria-hidden="true" className="contents">
						<Loader size="sm" />
					</span>
				) : (
					<FloppyDisk aria-hidden="true" />
				))
			}
			aria-label={ariaLabel ?? label}
			aria-busy={isBusy}
		>
			{label}
		</Button>
	);
}

export interface SaveStatusProps extends Omit<ComponentProps<"span">, "children"> {
	isDirty: boolean;
	isSaving: boolean;
	announce?: boolean;
}

export function SaveStatus({
	isDirty,
	isSaving,
	announce = true,
	className,
	style,
	...props
}: SaveStatusProps) {
	const { t } = useLingui();
	const savingLabel = t`Saving...`;
	const savedLabel = t`Saved`;

	return (
		<span
			{...props}
			data-save-status-slot=""
			className={cn("shrink-0 text-xs text-kumo-subtle", className)}
			style={{ display: "inline-grid", ...style }}
		>
			<span
				aria-hidden="true"
				className="invisible inline-flex items-center gap-1"
				style={{ gridArea: "status" }}
			>
				{savingLabel}
			</span>
			<span
				aria-hidden="true"
				className="invisible inline-flex items-center gap-1"
				style={{ gridArea: "status" }}
			>
				<Check className="size-3.5" />
				{savedLabel}
			</span>
			<span
				data-save-status-value=""
				className="inline-flex items-center gap-1 justify-self-end"
				style={{ gridArea: "status" }}
				role={announce ? "status" : undefined}
				aria-live={announce ? "polite" : undefined}
				aria-atomic={announce || undefined}
			>
				{isSaving ? (
					savingLabel
				) : !isDirty ? (
					<>
						<Check className="size-3.5 text-kumo-success" aria-hidden="true" />
						{savedLabel}
					</>
				) : null}
			</span>
		</span>
	);
}

export default SaveButton;
