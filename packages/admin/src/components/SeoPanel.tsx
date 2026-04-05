/**
 * SEO Panel for Content Editor Sidebar
 *
 * Shows SEO metadata fields (title, description, OG image, canonical URL,
 * noIndex) when the collection has `hasSeo` enabled. Changes are sent
 * alongside content updates via the `seo` field on the update body.
 */

import { Input, InputArea, Label, Switch } from "@cloudflare/kumo";
import * as React from "react";

import type { ContentSeo, ContentSeoInput } from "../lib/api";
import { useDebouncedValue } from "../lib/hooks";

export interface SeoPanelProps {
	contentKey?: string;
	seo?: ContentSeo;
	onChange: (seo: ContentSeoInput) => void;
}

const SEO_TEXT_DEBOUNCE_MS = 500;

interface SeoDraft {
	title: string;
	description: string;
	canonical: string;
	noIndex: boolean;
}

function toDraft(seo?: ContentSeo): SeoDraft {
	return {
		title: seo?.title ?? "",
		description: seo?.description ?? "",
		canonical: seo?.canonical ?? "",
		noIndex: seo?.noIndex ?? false,
	};
}

function toInput(draft: SeoDraft): ContentSeoInput {
	return {
		title: draft.title || null,
		description: draft.description || null,
		canonical: draft.canonical || null,
		noIndex: draft.noIndex,
	};
}

function serializeDraft(draft: SeoDraft): string {
	return JSON.stringify(draft);
}

/**
 * Compact SEO metadata editor for the content sidebar.
 */
export function SeoPanel({ contentKey, seo, onChange }: SeoPanelProps) {
	const propDraft = React.useMemo(() => toDraft(seo), [seo]);
	const propSnapshot = React.useMemo(() => serializeDraft(propDraft), [propDraft]);
	const [draft, setDraft] = React.useState<SeoDraft>(propDraft);
	const currentDraftRef = React.useRef(draft);
	currentDraftRef.current = draft;
	const lastPropSnapshotRef = React.useRef(propSnapshot);
	const lastEmittedSnapshotRef = React.useRef(propSnapshot);
	const previousContentKeyRef = React.useRef(contentKey);

	// Reset local state when the editor switches to a different content item.
	React.useEffect(() => {
		if (previousContentKeyRef.current === contentKey) {
			return;
		}
		previousContentKeyRef.current = contentKey;
		setDraft(propDraft);
		currentDraftRef.current = propDraft;
		lastPropSnapshotRef.current = propSnapshot;
		lastEmittedSnapshotRef.current = propSnapshot;
	}, [contentKey, propDraft, propSnapshot]);

	// When fresh server data arrives for the same item, only sync it back into
	// local state if the user is not ahead of that response.
	React.useEffect(() => {
		const previousPropSnapshot = lastPropSnapshotRef.current;
		if (propSnapshot === previousPropSnapshot) {
			return;
		}

		const currentDraftSnapshot = serializeDraft(currentDraftRef.current);
		const shouldSync =
			currentDraftSnapshot === previousPropSnapshot || currentDraftSnapshot === propSnapshot;

		if (shouldSync) {
			setDraft(propDraft);
			currentDraftRef.current = propDraft;
			lastEmittedSnapshotRef.current = propSnapshot;
		}

		lastPropSnapshotRef.current = propSnapshot;
	}, [propDraft, propSnapshot]);

	const debouncedTextDraft = useDebouncedValue(
		{
			title: draft.title,
			description: draft.description,
			canonical: draft.canonical,
		},
		SEO_TEXT_DEBOUNCE_MS,
	);

	React.useEffect(() => {
		const nextDraft: SeoDraft = {
			...currentDraftRef.current,
			title: debouncedTextDraft.title,
			description: debouncedTextDraft.description,
			canonical: debouncedTextDraft.canonical,
		};
		const nextSnapshot = serializeDraft(nextDraft);
		if (nextSnapshot === lastEmittedSnapshotRef.current) {
			return;
		}
		lastEmittedSnapshotRef.current = nextSnapshot;
		onChange(toInput(nextDraft));
	}, [debouncedTextDraft, onChange]);

	const updateDraft = (patch: Partial<SeoDraft>) => {
		currentDraftRef.current = { ...currentDraftRef.current, ...patch };
		setDraft((prev) => {
			return { ...prev, ...patch };
		});
	};

	return (
		<div className="space-y-3">
			<Input
				label="SEO Title"
				description="Overrides the page title in search engine results"
				value={draft.title}
				onChange={(e) => {
					updateDraft({ title: e.target.value });
				}}
			/>

			<div>
				<InputArea
					label="Meta Description"
					description={
						draft.description
							? `${draft.description.length}/160 characters`
							: "Brief summary shown below the title in search results"
					}
					value={draft.description}
					onChange={(e) => {
						updateDraft({ description: e.target.value });
					}}
					rows={3}
				/>
			</div>

			<Input
				label="Canonical URL"
				description="Points search engines to the original version of this page, if it's duplicated from another URL"
				value={draft.canonical}
				onChange={(e) => {
					updateDraft({ canonical: e.target.value });
				}}
			/>

			<div className="flex items-center justify-between pt-1">
				<div>
					<Label>Hide from search engines</Label>
					<p className="text-xs text-kumo-subtle">Add noindex meta tag</p>
				</div>
				<Switch
					checked={draft.noIndex}
					onCheckedChange={(checked) => {
						const nextDraft = { ...currentDraftRef.current, noIndex: checked };
						updateDraft({ noIndex: checked });
						const nextSnapshot = serializeDraft(nextDraft);
						if (nextSnapshot === lastEmittedSnapshotRef.current) {
							return;
						}
						lastEmittedSnapshotRef.current = nextSnapshot;
						onChange(toInput(nextDraft));
					}}
				/>
			</div>
		</div>
	);
}
