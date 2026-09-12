import { Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchTaxonomyDefs, fetchTerms, type TaxonomyTerm } from "../lib/api";

/**
 * Taxonomy-term filters for the content list, keyed by taxonomy name.
 *
 * One key per taxonomy the user has narrowed. A key is present only while it
 * has a selection: an empty array means "match nothing" to the server, which is
 * not what an untouched control means.
 */
export type TermFilterState = Record<string, string[]>;

export const EMPTY_TERM_FILTER: TermFilterState = {};

/** Depth-first flatten so a hierarchical taxonomy reads as an indented list. */
function flatten(terms: TaxonomyTerm[], depth = 0): Array<{ term: TaxonomyTerm; depth: number }> {
	return terms.flatMap((term) => [{ term, depth }, ...flatten(term.children ?? [], depth + 1)]);
}

/**
 * A dropdown per taxonomy applied to this collection, beside the status,
 * author and byline filters.
 *
 * Renders nothing when the collection has no taxonomies, so collections that
 * do not use them are unchanged.
 */
export function TermFilters({
	collection,
	value,
	onChange,
	locale,
}: {
	collection: string;
	value: TermFilterState;
	onChange: (next: TermFilterState) => void;
	locale?: string;
}) {
	const { t } = useLingui();

	const { data: defs } = useQuery({
		queryKey: ["taxonomy-defs", locale],
		queryFn: () => fetchTaxonomyDefs({ locale }),
		placeholderData: keepPreviousData,
	});

	const applicable = React.useMemo(
		() => (defs ?? []).filter((def) => def.collections.includes(collection)),
		[defs, collection],
	);

	if (applicable.length === 0) return null;

	return (
		<>
			{applicable.map((def) => (
				<TermSelect
					key={def.name}
					name={def.name}
					label={def.label}
					locale={locale}
					selected={value[def.name]?.[0] ?? ""}
					onSelect={(slug) => {
						const next = { ...value };
						// Dropping the key rather than storing an empty array keeps
						// "no selection" distinct from "match nothing".
						if (slug) next[def.name] = [slug];
						else delete next[def.name];
						onChange(next);
					}}
					allLabel={t`All ${def.label.toLowerCase()}`}
					ariaLabel={t`Filter by ${def.label.toLowerCase()}`}
				/>
			))}
		</>
	);
}

function TermSelect({
	name,
	locale,
	selected,
	onSelect,
	allLabel,
	ariaLabel,
}: {
	name: string;
	label: string;
	locale?: string;
	selected: string;
	onSelect: (slug: string) => void;
	allLabel: string;
	ariaLabel: string;
}) {
	// Terms load per taxonomy and only for taxonomies actually on screen, so a
	// site with several does not pay for all of them at once.
	const { data: terms } = useQuery({
		queryKey: ["taxonomy-terms", name, locale],
		queryFn: () => fetchTerms(name, { locale }),
		placeholderData: keepPreviousData,
	});

	const options = React.useMemo(() => flatten(terms ?? []), [terms]);
	if (options.length === 0) return null;

	return (
		<Select
			size="sm"
			aria-label={ariaLabel}
			value={selected}
			onValueChange={(v) => onSelect(v ?? "")}
			items={{
				"": allLabel,
				...Object.fromEntries(options.map(({ term }) => [term.slug, term.label])),
			}}
		>
			<Select.Option value="">{allLabel}</Select.Option>
			{options.map(({ term, depth }) => (
				<Select.Option key={term.id} value={term.slug}>
					{depth > 0 ? `${"  ".repeat(depth)}${term.label}` : term.label}
				</Select.Option>
			))}
		</Select>
	);
}
