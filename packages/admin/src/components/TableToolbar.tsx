import { InputGroup } from "@cloudflare/kumo";
import { MagnifyingGlass } from "@phosphor-icons/react";
import type * as React from "react";

import { cn } from "../lib/utils.js";

interface TableToolbarProps {
	children: React.ReactNode;
	trailing?: React.ReactNode;
	className?: string;
}

export function TableToolbar({ children, trailing, className }: TableToolbarProps) {
	return (
		<div
			className={cn(
				"flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between",
				className,
			)}
		>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">{children}</div>
			{trailing && <div className="flex shrink-0 flex-wrap items-center gap-2">{trailing}</div>}
		</div>
	);
}

interface TableToolbarSearchProps {
	value: string;
	onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
	placeholder: string;
	"aria-label": string;
	size?: React.ComponentProps<typeof InputGroup>["size"];
	maxLength?: number;
	className?: string;
}

export function TableToolbarSearch({
	value,
	onChange,
	placeholder,
	"aria-label": ariaLabel,
	size = "sm",
	maxLength,
	className,
}: TableToolbarSearchProps) {
	return (
		<InputGroup size={size} className={cn("w-full min-w-0 sm:w-64 sm:flex-none", className)}>
			<InputGroup.Addon>
				<MagnifyingGlass className="h-4 w-4" aria-hidden="true" />
			</InputGroup.Addon>
			<InputGroup.Input
				type="search"
				placeholder={placeholder}
				aria-label={ariaLabel}
				value={value}
				onChange={onChange}
				maxLength={maxLength}
			/>
		</InputGroup>
	);
}
