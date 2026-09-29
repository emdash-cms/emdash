import { Button, DropdownMenu } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, X } from "@phosphor-icons/react";
import type * as React from "react";

import {
	CALENDAR_STATES,
	type CalendarDisplay,
	type CalendarFilterValues,
	type CalendarState,
} from "../../lib/calendar.js";
import { getLocaleLabel } from "../../locales/index.js";
import {
	CALENDAR_STATE_LABELS,
	CalendarCollectionDot,
	CalendarStateIcon,
} from "./CalendarEntry.js";

export interface CalendarFilterOption {
	value: string;
	label: string;
	/** A small visual cue before the label, such as a color dot or an icon. */
	swatch?: React.ReactNode;
}

interface CalendarFilterMenuProps {
	/** What the menu filters, announced before the summary ("Collection: 2 collections"). */
	label: string;
	/** The trigger text, describing the current selection. */
	summary: string;
	options: readonly CalendarFilterOption[];
	/** Selected values; an empty selection means all. */
	selected: readonly string[];
	onChange: (selected: string[]) => void;
}

/** A multi-select dropdown whose trigger summarizes the selection. */
export function CalendarFilterMenu({
	label,
	summary,
	options,
	selected,
	onChange,
}: CalendarFilterMenuProps) {
	const { t } = useLingui();
	return (
		<DropdownMenu>
			<DropdownMenu.Trigger
				render={
					<Button
						variant="secondary"
						size="sm"
						className="gap-1 px-3 font-normal"
						aria-label={t`${label}: ${summary}`}
					>
						<span className="max-w-40 truncate">{summary}</span>
						<CaretDown aria-hidden="true" className="size-3 shrink-0" />
					</Button>
				}
			/>
			<DropdownMenu.Content align="start" className="min-w-52">
				<DropdownMenu.Group>
					<DropdownMenu.Label>{label}</DropdownMenu.Label>
					{options.map((option) => (
						<DropdownMenu.CheckboxItem
							key={option.value}
							checked={selected.includes(option.value)}
							closeOnClick={false}
							onCheckedChange={(checked) =>
								onChange(
									checked
										? [...selected, option.value]
										: selected.filter((value) => value !== option.value),
								)
							}
						>
							<span className="flex min-w-0 items-center gap-2">
								{option.swatch}
								<span className="truncate">{option.label}</span>
							</span>
						</DropdownMenu.CheckboxItem>
					))}
				</DropdownMenu.Group>
			</DropdownMenu.Content>
		</DropdownMenu>
	);
}

interface CalendarFiltersProps {
	display: CalendarDisplay;
	collections: ReadonlyArray<{ slug: string; label: string }>;
	/** Content locales; the locale menu shows only when there is more than one. */
	locales: readonly string[];
	value: CalendarFilterValues;
	onChange: (value: Partial<CalendarFilterValues>) => void;
}

export function CalendarFilters({
	display,
	collections,
	locales,
	value,
	onChange,
}: CalendarFiltersProps) {
	const { t } = useLingui();
	const active = value.collections.length + value.locales.length + value.states.length > 0;

	const collectionSummary =
		value.collections.length === 0
			? t`All collections`
			: value.collections.length === 1
				? display.collection(value.collections[0] ?? "").label
				: plural(value.collections.length, { one: "# collection", other: "# collections" });
	const localeSummary =
		value.locales.length === 0
			? t`All locales`
			: value.locales.length === 1
				? getLocaleLabel(value.locales[0] ?? "")
				: plural(value.locales.length, { one: "# locale", other: "# locales" });
	const firstState = value.states[0];
	const stateSummary =
		value.states.length === 0
			? t`All states`
			: value.states.length === 1 && firstState
				? t(CALENDAR_STATE_LABELS[firstState])
				: plural(value.states.length, { one: "# state", other: "# states" });

	return (
		<div className="flex flex-wrap items-center gap-2">
			<CalendarFilterMenu
				label={t`Collection`}
				summary={collectionSummary}
				selected={value.collections}
				onChange={(selected) => onChange({ collections: selected })}
				options={collections.map((collection) => ({
					value: collection.slug,
					label: collection.label,
					swatch: <CalendarCollectionDot color={display.collection(collection.slug).color} />,
				}))}
			/>
			{locales.length > 1 && (
				<CalendarFilterMenu
					label={t`Locale`}
					summary={localeSummary}
					selected={value.locales}
					onChange={(selected) => onChange({ locales: selected })}
					options={locales.map((locale) => ({ value: locale, label: getLocaleLabel(locale) }))}
				/>
			)}
			<CalendarFilterMenu
				label={t`State`}
				summary={stateSummary}
				selected={value.states}
				onChange={(selected) =>
					onChange({ states: CALENDAR_STATES.filter((state) => selected.includes(state)) })
				}
				options={CALENDAR_STATES.map((state: CalendarState) => ({
					value: state,
					label: t(CALENDAR_STATE_LABELS[state]),
					swatch: <CalendarStateIcon state={state} />,
				}))}
			/>
			{active && (
				<Button
					variant="ghost"
					size="sm"
					icon={<X aria-hidden="true" />}
					onClick={() => onChange({ collections: [], locales: [], states: [] })}
				>
					{t`Clear filters`}
				</Button>
			)}
		</div>
	);
}
