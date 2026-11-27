import { Button, Checkbox, Input, Popover } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretUpDown } from "@phosphor-icons/react";
import * as React from "react";

import { cn } from "../lib/utils.js";

export interface FilterMenuOption {
	value: string;
	label: string;
	disabled?: boolean;
}

export interface FilterMenuSearch {
	value: string;
	onChange: (value: string) => void;
	label: string;
	placeholder: string;
}

export interface FilterMenuProps {
	/** The trigger's accessible name, such as "Filter by byline". */
	label: string;
	/** What the trigger shows: the current selection, or what an empty selection matches. */
	value: string;
	options: readonly FilterMenuOption[];
	selected: readonly string[];
	onToggle: (value: string) => void;
	/** The accessible name of the group of options. */
	listLabel: string;
	search?: FilterMenuSearch;
	loading?: boolean;
	/** Shown when there are no options and nothing is loading. */
	emptyText: string;
	/** Shown after the options, such as a prompt to search when the list is cut short. */
	hint?: string;
	/** Rendered between the search box and the options. */
	header?: React.ReactNode;
	/** Rendered below the options. */
	footer?: React.ReactNode;
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
	/** Classes for the trigger. */
	className?: string;
}

/**
 * A compact multi-select filter for a table toolbar. The trigger matches a Kumo `Select` with
 * `size="sm"`; the popup lists checkbox options in the same small type as that Select's options.
 */
export function FilterMenu({
	label,
	value,
	options,
	selected,
	onToggle,
	listLabel,
	search,
	loading = false,
	emptyText,
	hint,
	header,
	footer,
	open,
	onOpenChange,
	className,
}: FilterMenuProps) {
	const { t } = useLingui();
	return (
		<Popover open={open} onOpenChange={onOpenChange}>
			<Popover.Trigger
				render={
					<Button
						variant="secondary"
						size="sm"
						aria-label={label}
						className={cn(
							"justify-between bg-kumo-control font-normal focus:opacity-100 focus:ring-kumo-focus/50 focus-visible:ring-inset disabled:bg-kumo-control/50 data-[state=open]:bg-kumo-control *:in-focus:opacity-100",
							className,
						)}
					/>
				}
			>
				<span className="min-w-0 max-w-35 truncate">{value}</span>
				<span className="flex shrink-0 items-center text-kumo-subtle" aria-hidden="true">
					<CaretUpDown size={14} className="fill-current" />
				</span>
			</Popover.Trigger>

			<Popover.Portal>
				<Popover.Positioner side="bottom" align="start" sideOffset={4}>
					<Popover.Popup className="w-60 min-w-(--anchor-width) max-w-[calc(100vw-2rem)] px-0 py-1.5 text-xs">
						{search && (
							<div className="px-1.5 pb-1.5">
								<Input
									size="sm"
									type="search"
									className="w-full"
									aria-label={search.label}
									placeholder={search.placeholder}
									value={search.value}
									onChange={(event) => search.onChange(event.target.value)}
								/>
							</div>
						)}

						{header && <div className="mb-1 border-b border-kumo-line pb-1">{header}</div>}

						<div className="max-h-64 overflow-y-auto" role="group" aria-label={listLabel}>
							{loading && <FilterMenuMessage>{t`Loading…`}</FilterMenuMessage>}
							{!loading && options.length === 0 && (
								<FilterMenuMessage>{emptyText}</FilterMenuMessage>
							)}
							{options.map((option) => (
								<FilterMenuCheckbox
									key={option.value}
									label={option.label}
									checked={selected.includes(option.value)}
									disabled={option.disabled}
									onCheckedChange={() => onToggle(option.value)}
								/>
							))}
							{hint && <FilterMenuMessage>{hint}</FilterMenuMessage>}
						</div>

						{footer && (
							<div className="mt-1.5 grid gap-2 border-t border-kumo-line px-3.5 pt-2">
								{footer}
							</div>
						)}
					</Popover.Popup>
				</Popover.Positioner>
			</Popover.Portal>
		</Popover>
	);
}

/** One checkbox row in a `FilterMenu`, for a choice that sits outside its options. */
export function FilterMenuCheckbox({
	label,
	checked,
	disabled,
	onCheckedChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	return (
		<div className="mx-1.5 flex rounded px-2 py-1.5 hover:bg-kumo-tint [&_*]:min-w-0">
			<Checkbox
				className="mt-0"
				checked={checked}
				disabled={disabled}
				onCheckedChange={(next) => onCheckedChange(next)}
				label={
					<span className="block truncate text-xs font-normal" title={label}>
						{label}
					</span>
				}
			/>
		</div>
	);
}

function FilterMenuMessage({ children }: { children: React.ReactNode }) {
	return <p className="px-3.5 py-1.5 text-xs text-kumo-subtle">{children}</p>;
}
