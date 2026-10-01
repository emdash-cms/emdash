import { Badge, Button, DropdownMenu } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, Funnel, X } from "@phosphor-icons/react";
import type * as React from "react";

import {
	CALENDAR_STATES,
	type CalendarDisplay,
	type CalendarFilterValues,
} from "../../lib/calendar.js";
import { getLocaleLabel } from "../../locales/index.js";
import {
	CALENDAR_STATE_LABELS,
	CalendarCollectionTag,
	CalendarStateIcon,
} from "./CalendarEntry.js";

type FilterKey = keyof CalendarFilterValues;

interface CalendarFilterGroup {
	key: FilterKey;
	label: string;
	options: ReadonlyArray<{ value: string; content: React.ReactNode }>;
}

interface CalendarFiltersProps {
	display: CalendarDisplay;
	collections: ReadonlyArray<{ slug: string; label: string }>;
	/** Content locales; the locale filter shows only when there is more than one. */
	locales: readonly string[];
	value: CalendarFilterValues;
	onChange: (value: Partial<CalendarFilterValues>) => void;
	triggerRef?: React.Ref<HTMLButtonElement>;
}

const NO_FILTERS: CalendarFilterValues = { collections: [], locales: [], states: [] };

/**
 * A checkbox drawn like Kumo's, for menu items that otherwise show only a
 * check mark once chosen. It follows the item's checked state.
 */
function MenuCheckbox() {
	return (
		<span
			aria-hidden="true"
			className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-kumo-base ring ring-kumo-interact transition-colors group-data-checked:bg-kumo-contrast group-data-checked:ring-kumo-contrast motion-reduce:transition-none"
		>
			<Check
				weight="bold"
				size={12}
				className="invisible text-kumo-inverse group-data-checked:visible"
			/>
		</span>
	);
}

/** One menu for every filter; an empty selection in a group means all of it. */
export function CalendarFilters({
	display,
	collections,
	locales,
	value,
	onChange,
	triggerRef,
}: CalendarFiltersProps) {
	const { t } = useLingui();
	const groups: CalendarFilterGroup[] = [
		{
			key: "collections",
			label: t`Collection`,
			options: collections.map((collection) => ({
				value: collection.slug,
				content: <CalendarCollectionTag slug={collection.slug} display={display} />,
			})),
		},
		...(locales.length > 1
			? [
					{
						key: "locales" as const,
						label: t`Locale`,
						options: locales.map((locale) => ({
							value: locale,
							content: (
								<>
									<span
										aria-hidden="true"
										className="w-7 shrink-0 rounded-sm bg-kumo-fill py-0.5 text-center text-[10px] leading-4 font-semibold tracking-wide text-kumo-subtle uppercase"
									>
										{locale}
									</span>
									<span className="truncate">{getLocaleLabel(locale)}</span>
								</>
							),
						})),
					},
				]
			: []),
		{
			key: "states",
			label: t`State`,
			options: CALENDAR_STATES.map((state) => ({
				value: state,
				content: (
					<>
						<CalendarStateIcon state={state} />
						<span className="truncate">{t(CALENDAR_STATE_LABELS[state])}</span>
					</>
				),
			})),
		},
	];
	const activeCount = value.collections.length + value.locales.length + value.states.length;

	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					<Button
						ref={triggerRef}
						variant="secondary"
						className="w-full justify-center text-sm sm:w-auto"
						icon={
							<Funnel
								aria-hidden="true"
								weight={activeCount > 0 ? "fill" : "regular"}
								className="size-4"
							/>
						}
						aria-label={activeCount > 0 ? t`Filter: ${activeCount} selected` : undefined}
					>
						{t`Filter`}
						{activeCount > 0 && (
							<Badge variant="blue" className="min-w-5 justify-center px-1 tabular-nums">
								{activeCount}
							</Badge>
						)}
					</Button>
				}
			/>
			<DropdownMenu.Content
				align="end"
				// Kumo's menu animates on Radix's data-state, which Base UI never sets, so this uses its popover transition.
				className="max-h-[min(32rem,var(--available-height))] w-[max(15rem,var(--anchor-width))] origin-(--transform-origin) overflow-y-auto transition-[transform,scale,opacity] duration-150 data-ending-style:scale-90 data-ending-style:opacity-0 data-instant:duration-0 data-starting-style:scale-90 data-starting-style:opacity-0 motion-reduce:transition-none"
			>
				{groups.map((group, index) => {
					const selected: readonly string[] = value[group.key];
					return (
						<DropdownMenu.Group key={group.key} className={index > 0 ? "mt-1" : undefined}>
							<DropdownMenu.Label className="pt-2 pb-1 text-xs text-kumo-subtle">
								{group.label}
							</DropdownMenu.Label>
							{group.options.map((option) => (
								<DropdownMenu.CheckboxItem
									key={option.value}
									checked={selected.includes(option.value)}
									closeOnClick={false}
									// Kumo's own check mark is hidden in favor of the drawn checkbox.
									className="group gap-2.5 px-2 [&>[data-checked]]:hidden"
									onCheckedChange={(checked) => {
										const next = checked
											? [...selected, option.value]
											: selected.filter((entry) => entry !== option.value);
										// Menu order keeps the URL stable however the options were picked.
										onChange({
											[group.key]: group.options
												.map((entry) => entry.value)
												.filter((entry) => next.includes(entry)),
										});
									}}
								>
									<MenuCheckbox />
									<span className="flex min-w-0 items-center gap-2">{option.content}</span>
								</DropdownMenu.CheckboxItem>
							))}
						</DropdownMenu.Group>
					);
				})}
				{activeCount > 0 && (
					<>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							icon={<X aria-hidden="true" className="size-4" />}
							className="gap-2.5 data-highlighted:bg-kumo-tint"
							onClick={() => onChange(NO_FILTERS)}
						>
							{t`Clear filters`}
						</DropdownMenu.Item>
					</>
				)}
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}
