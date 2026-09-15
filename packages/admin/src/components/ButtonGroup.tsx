import { forwardRef, type HTMLAttributes, type ReactNode } from "react";

import { cn } from "../lib/utils.js";

export const KUMO_BUTTON_GROUP_VARIANTS = {} as const;

export const KUMO_BUTTON_GROUP_DEFAULT_VARIANTS = {} as const;

export const KUMO_BUTTON_GROUP_STYLING = {
	baseClasses: cn(
		"relative isolate inline-flex w-max flex-row",
		"[&>*]:relative [&>*:focus-visible]:z-10 [&>*:has(:focus-visible)]:z-10",
		"[&>*>:is(button,a)]:shadow-none [&>:is(button,a)]:shadow-none",
		"[&>*:not(:first-child):is(button,a)]:rounded-s-none",
		"[&>*:not(:last-child):is(button,a)]:rounded-e-none",
		"[&>*:not(:first-child)>:is(button,a)]:rounded-s-none",
		"[&>*:not(:last-child)>:is(button,a)]:rounded-e-none",
		"[&>*:not(:first-child)]:-ms-px",
	),
} as const;

export interface ButtonGroupProps extends Omit<HTMLAttributes<HTMLDivElement>, "role"> {
	className?: string;
	children?: ReactNode;
}

export const ButtonGroup = forwardRef<HTMLDivElement, ButtonGroupProps>(
	({ className, children, ...props }, ref) => {
		return (
			<div
				{...props}
				ref={ref}
				role="group"
				data-kumo-component="ButtonGroup"
				className={cn(KUMO_BUTTON_GROUP_STYLING.baseClasses, className)}
			>
				{children}
			</div>
		);
	},
);

ButtonGroup.displayName = "ButtonGroup";
