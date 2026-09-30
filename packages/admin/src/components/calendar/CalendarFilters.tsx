import { Badge, Button, DropdownMenu } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, Funnel, X } from "@phosphor-icons/react";
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

interface CalendarFilterOption {
	value: string;
	/** The plain name, for the trigger's summary. */
	label: string;
	/** What the menu shows for the option, such as a tag or an icon with the name. */
	content: React.ReactNode;
}

interface CalendarFilterGroup {
	key: FilterKey;
	label: string;
	options: readonly CalendarFilterOption[];
}

interface CalendarFiltersProps {
	display: CalendarDisplay;
	collections: ReadonlyArray<{ slug: string; label: string }>;
	/** Content locales; the locale filter shows only when there is more than one. */
	locales: readonly string[];
	value: CalendarFilterValues;
	onChange: (value: Partial<CalendarFilterValues>) => void;
	/** Narrow layouts put every filter in one menu. */
	compact?: boolean;
}

const NO_FILTERS: CalendarFilterValues = { collections: [], locales: [], states: [] };

/** The checkbox groups a filter menu lists; an empty selection means all. */
function CalendarFilterOptions({
	groups,
	value,
	onChange,
}: {
	groups: readonly CalendarFilterGroup[];
	value: CalendarFilterValues;
	onChange: (value: Partial<CalendarFilterValues>) => void;
}) {
	return groups.map((group) => {
		const selected: readonly string[] = value[group.key];
		return (
			<DropdownMenu.Group key={group.key}>
				<DropdownMenu.Label>{group.label}</DropdownMenu.Label>
				{group.options.map((option) => (
					<DropdownMenu.CheckboxItem
						key={option.value}
						checked={selected.includes(option.value)}
						closeOnClick={false}
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
						<span className="flex min-w-0 items-center gap-2">{option.content}</span>
					</DropdownMenu.CheckboxItem>
				))}
			</DropdownMenu.Group>
		);
	});
}

export function CalendarFilters({
	display,
	collections,
	locales,
	value,
	onChange,
	compact,
}: CalendarFiltersProps) {
	const { t } = useLingui();
	const groups: CalendarFilterGroup[] = [
		{
			key: "collections",
			label: t`Collection`,
			options: collections.map((collection) => ({
				value: collection.slug,
				label: collection.label,
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
							label: getLocaleLabel(locale),
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
				label: t(CALENDAR_STATE_LABELS[state]),
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

	if (compact) {
		return (
			<DropdownMenu>
				<DropdownMenu.Trigger
					render={
						<Button
							variant={activeCount > 0 ? "secondary" : "ghost"}
							size="sm"
							icon={<Funnel aria-hidden="true" />}
							aria-label={activeCount > 0 ? t`Filter: ${activeCount} selected` : t`Filter`}
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
				<DropdownMenu.Content align="end" className="max-h-[70dvh] min-w-60 overflow-y-auto">
					<CalendarFilterOptions groups={groups} value={value} onChange={onChange} />
					{activeCount > 0 && (
						<>
							<DropdownMenu.Separator />
							<DropdownMenu.Item
								icon={<X aria-hidden="true" className="me-1.5 size-3.5" />}
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

	return (
		<div className="flex flex-wrap items-center justify-end gap-1">
			{groups.map((group) => {
				const selected: readonly string[] = value[group.key];
				const first = group.options.find((option) => option.value === selected[0])?.label;
				const more = selected.length - 1;
				const summary = !first
					? group.label
					: more > 0
						? t`${group.label}: ${first} +${more}`
						: t`${group.label}: ${first}`;
				return (
					<DropdownMenu key={group.key}>
						<DropdownMenu.Trigger
							render={
								<Button
									variant={first ? "secondary" : "ghost"}
									size="sm"
									className="gap-1 font-normal"
								>
									<span className="max-w-48 truncate">{summary}</span>
									<CaretDown aria-hidden="true" className="size-3 shrink-0" />
								</Button>
							}
						/>
						<DropdownMenu.Content align="end" className="min-w-56">
							<CalendarFilterOptions groups={[group]} value={value} onChange={onChange} />
						</DropdownMenu.Content>
					</DropdownMenu>
				);
			})}
			{activeCount > 0 && (
				<Button
					variant="ghost"
					size="sm"
					icon={<X aria-hidden="true" />}
					onClick={() => onChange(NO_FILTERS)}
				>
					{t`Clear filters`}
				</Button>
			)}
		</div>
	);
}
