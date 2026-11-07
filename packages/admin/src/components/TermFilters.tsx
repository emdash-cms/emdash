import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchTaxonomyDefs } from "../lib/api";
import { resolveTaxonomyDefinitions } from "../lib/taxonomy-definitions.js";
import { fetchTerms, TaxonomyTermPicker, type TaxonomyTerm } from "./TaxonomySidebar.js";

/**
 * Taxonomy-term filters for the content list: term slugs keyed by taxonomy
 * name.
 *
 * A key is present only while it has a selection. The server reads an empty
 * array as "match nothing", which is not what an untouched control means.
 */
export type TermFilterState = Record<string, string[]>;

export const EMPTY_TERM_FILTER: TermFilterState = {};

export function isTermFilterActive(filter: TermFilterState): boolean {
	return Object.values(filter).some((slugs) => slugs.length > 0);
}

const NO_CREATE = () => {};

/**
 * One term picker per taxonomy applied to this collection, beside the status,
 * author and byline filters. Renders nothing for a collection without
 * taxonomies.
 */
export function TermFilters({
	collection,
	value,
	onChange,
	locale,
	defaultLocale,
}: {
	collection: string;
	value: TermFilterState;
	onChange: (next: TermFilterState) => void;
	/** Locale the list is showing; terms load for it with default-locale fallback. */
	locale?: string;
	defaultLocale?: string;
}) {
	const { data: defs = [] } = useQuery({
		queryKey: ["taxonomy-defs"],
		queryFn: () => fetchTaxonomyDefs(),
	});
	const applicable = React.useMemo(
		() =>
			resolveTaxonomyDefinitions(defs, locale, defaultLocale).filter((def) =>
				def.collections.includes(collection),
			),
		[defs, locale, defaultLocale, collection],
	);

	return applicable.map((def) => (
		<TaxonomyTermFilter
			key={def.name}
			name={def.name}
			label={def.label}
			singularLabel={def.labelSingular || def.label}
			locale={locale}
			slugs={value[def.name] ?? []}
			onSlugsChange={(slugs) => {
				const next = { ...value };
				// Drop the key rather than store an empty array, so "no selection"
				// never reaches the server as "match nothing".
				if (slugs.length > 0) next[def.name] = slugs;
				else delete next[def.name];
				onChange(next);
			}}
		/>
	));
}

function TaxonomyTermFilter({
	name,
	label,
	singularLabel,
	locale,
	slugs,
	onSlugsChange,
}: {
	name: string;
	label: string;
	singularLabel: string;
	locale?: string;
	slugs: string[];
	onSlugsChange: (slugs: string[]) => void;
}) {
	const { t } = useLingui();
	// The same request the entry editor's picker makes: the list's locale with
	// default-locale fallback, and no usage counts.
	const { data: terms = [] } = useQuery({
		queryKey: ["taxonomy-terms", name, locale, { includeCounts: false }],
		queryFn: () => fetchTerms(name, locale),
	});

	const flat = React.useMemo(() => flattenTerms(terms), [terms]);
	const selectedIds = React.useMemo(
		() => new Set(flat.filter((term) => slugs.includes(term.slug)).map((term) => term.id)),
		[flat, slugs],
	);
	if (terms.length === 0) return null;

	const first = flat.find((term) => term.slug === slugs[0]);
	const buttonLabel =
		slugs.length === 0
			? t`All ${label}`
			: slugs.length === 1 && first
				? first.label
				: plural(slugs.length, { one: `# ${singularLabel}`, other: `# ${label}` });

	return (
		<TaxonomyTermPicker
			terms={terms}
			selectedIds={selectedIds}
			onChange={(ids) => {
				const picked = new Set(ids);
				onSlugsChange([
					...new Set(flat.filter((term) => picked.has(term.id)).map((term) => term.slug)),
				]);
			}}
			onCreate={NO_CREATE}
			isCreating={false}
			label={label}
			entryLocale={locale}
			canCreate={false}
			allowDelimitedValues={false}
			singularLabel={singularLabel}
			toolbar={{ buttonLabel, ariaLabel: t`Filter by ${label}` }}
		/>
	);
}

function flattenTerms(terms: TaxonomyTerm[]): TaxonomyTerm[] {
	return terms.flatMap((term) => [term, ...flattenTerms(term.children)]);
}
