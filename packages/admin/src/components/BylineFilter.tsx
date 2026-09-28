import { Badge, Button, Checkbox, Input, Popover, Switch } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CaretDown } from "@phosphor-icons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchBylines, type BylineSummary } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks.js";
import { FieldHelpLabel } from "./FieldHelpLabel.js";

/**
 * Byline filter state for the content list.
 *
 * `bylineIds` are translation groups, so a selection matches a byline across
 * every locale it exists in. `none` is exclusive: it matches entries with no
 * byline rather than a particular one.
 */
export interface BylineFilterState {
	bylineIds: string[];
	none: boolean;
	includeInferred: boolean;
}

export const EMPTY_BYLINE_FILTER: BylineFilterState = {
	bylineIds: [],
	none: false,
	includeInferred: false,
};

export function isBylineFilterActive(filter: BylineFilterState): boolean {
	return filter.none || filter.bylineIds.length > 0;
}

/** Server-side cap on how many bylines one filter may name. */
const MAX_SELECTED = 25;

/** The junction stores translation groups, so a filter matches every locale. */
const groupOf = (byline: BylineSummary) => byline.translationGroup ?? byline.id;

interface BylineFilterProps {
	value: BylineFilterState;
	onChange: (value: BylineFilterState) => void;
	/** Locale the list is showing, so the picker offers matching byline rows. */
	locale?: string;
}

/**
 * Multi-select byline filter. Selecting several bylines matches entries
 * credited to any of them; "No byline" matches entries with no credit at all.
 */
export function BylineFilter({ value, onChange, locale }: BylineFilterProps) {
	const { t } = useLingui();
	const [open, setOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const inferredBylineId = React.useId();
	const debouncedSearch = useDebouncedValue(search, 300);
	const trimmedSearch = debouncedSearch.trim();

	const { data, isLoading } = useQuery({
		queryKey: ["bylines", "content-filter", locale ?? null, trimmedSearch],
		queryFn: () => fetchBylines({ search: trimmedSearch || undefined, locale, limit: 20 }),
		enabled: open,
		placeholderData: keepPreviousData,
	});

	const options = data?.items ?? [];

	// Selected bylines are remembered by group so their names keep rendering
	// once the search moves on and the rows are no longer in `options`.
	const [labels, setLabels] = React.useState<Record<string, string>>({});
	React.useEffect(() => {
		if (options.length === 0) return;
		setLabels((prev) => {
			const next = { ...prev };
			for (const byline of options) next[groupOf(byline)] = byline.displayName;
			return next;
		});
	}, [options]);

	const toggle = (group: string) => {
		const selected = value.bylineIds.includes(group);
		if (!selected && value.bylineIds.length >= MAX_SELECTED) return;
		onChange({
			...value,
			// Picking a byline leaves the "no byline" mode; the two are
			// mutually exclusive.
			none: false,
			bylineIds: selected
				? value.bylineIds.filter((id) => id !== group)
				: [...value.bylineIds, group],
		});
	};

	const toggleNone = () => {
		const none = !value.none;
		onChange({ ...value, none, bylineIds: none ? [] : value.bylineIds });
	};

	const label = value.none
		? t`No byline`
		: value.bylineIds.length === 0
			? t`All bylines`
			: value.bylineIds.length === 1
				? (labels[value.bylineIds[0]!] ?? plural(1, { one: "# byline", other: "# bylines" }))
				: plural(value.bylineIds.length, { one: "# byline", other: "# bylines" });

	const atLimit = value.bylineIds.length >= MAX_SELECTED;

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<Popover.Trigger asChild>
				<Button
					variant="secondary"
					size="sm"
					aria-label={t`Filter by byline`}
					className="emdash-byline-filter-trigger gap-1 px-3.5 font-normal"
				>
					<span className="max-w-[140px] truncate">{label}</span>
					<CaretDown className="size-3 shrink-0" aria-hidden="true" />
				</Button>
			</Popover.Trigger>

			<Popover.Content className="w-80 max-w-[calc(100vw-2rem)] p-3" align="start">
				<Input
					size="base"
					type="search"
					aria-label={t`Search bylines`}
					placeholder={t`Search bylines…`}
					value={search}
					onChange={(e) => setSearch(e.target.value)}
				/>

				<div className="mt-3 border-b px-1 pb-3">
					<Checkbox
						checked={value.none}
						onCheckedChange={toggleNone}
						label={t`No byline assigned`}
					/>
				</div>

				<div
					className="mt-2 max-h-64 space-y-0.5 overflow-y-auto"
					role="group"
					aria-label={t`Bylines`}
				>
					{isLoading && <p className="py-2 text-base text-kumo-subtle">{t`Loading…`}</p>}

					{!isLoading && options.length === 0 && (
						<p className="py-2 text-base text-kumo-subtle">{t`No bylines found`}</p>
					)}

					{options.map((byline) => {
						const group = groupOf(byline);
						const checked = value.bylineIds.includes(group);
						return (
							<div key={byline.id} className="rounded px-1 py-2 hover:bg-kumo-tint/50">
								<Checkbox
									checked={checked}
									disabled={!checked && (atLimit || value.none)}
									onCheckedChange={() => toggle(group)}
									label={<span className="text-base font-normal">{byline.displayName}</span>}
								/>
							</div>
						);
					})}

					{data?.nextCursor && (
						<p className="py-2 text-base text-kumo-subtle">{t`Search to narrow the list`}</p>
					)}
				</div>

				{atLimit && (
					<Badge className="mt-2" variant="warning">
						{t`Up to ${MAX_SELECTED} bylines can be selected`}
					</Badge>
				)}

				<div className="mt-3 border-t px-1 pt-3">
					<div className="flex items-center justify-between gap-3">
						<FieldHelpLabel
							htmlFor={inferredBylineId}
							help={t`Also match the byline linked to an entry's author when it has none assigned.`}
							helpLabel={t`About inferred bylines`}
							labelClassName="text-base font-normal text-kumo-default"
						>
							{t`Include inferred bylines`}
						</FieldHelpLabel>
						<Switch
							id={inferredBylineId}
							checked={value.includeInferred}
							onCheckedChange={(checked) => onChange({ ...value, includeInferred: checked })}
							aria-label={t`Include inferred bylines`}
						/>
					</div>
				</div>
			</Popover.Content>
		</Popover>
	);
}
