/**
 * SEO Panel for Content Editor Sidebar
 *
 * Shows SEO metadata fields (title, description, OG image, canonical URL,
 * noIndex) when the collection has `hasSeo` enabled. Changes are sent
 * alongside content updates via the `seo` field on the update body.
 */

import { Input, InputArea, Label, Switch } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { ContentSeo, ContentSeoInput } from "../lib/api";

export interface SeoPanelProps {
	contentKey: string;
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

export function SeoPanel({ contentKey, seo, onChange }: SeoPanelProps) {
	const { t } = useLingui();
	const propDraft = React.useMemo(() => toDraft(seo), [seo]);
	const propSnapshot = React.useMemo(() => serializeDraft(propDraft), [propDraft]);
	const [draft, setDraft] = React.useState<SeoDraft>(propDraft);
	const currentDraftRef = React.useRef(draft);
	currentDraftRef.current = draft;
	const lastPropSnapshotRef = React.useRef(propSnapshot);
	const lastEmittedSnapshotRef = React.useRef(propSnapshot);
	const activeContentKeyRef = React.useRef(contentKey);
	const activeOnChangeRef = React.useRef(onChange);
	const pendingTextFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	const emitChange = React.useCallback((nextDraft: SeoDraft) => {
		const nextSnapshot = serializeDraft(nextDraft);
		if (nextSnapshot === lastEmittedSnapshotRef.current) {
			return;
		}
		lastEmittedSnapshotRef.current = nextSnapshot;
		activeOnChangeRef.current(toInput(nextDraft));
	}, []);

	const clearPendingTextFlush = React.useCallback(() => {
		if (pendingTextFlushTimerRef.current) {
			clearTimeout(pendingTextFlushTimerRef.current);
			pendingTextFlushTimerRef.current = null;
		}
	}, []);

	const flushPendingDraft = React.useCallback(() => {
		clearPendingTextFlush();
		emitChange(currentDraftRef.current);
	}, [clearPendingTextFlush, emitChange]);

	React.useEffect(() => {
		if (activeContentKeyRef.current === contentKey) {
			activeOnChangeRef.current = onChange;
			return;
		}
		flushPendingDraft();
		activeContentKeyRef.current = contentKey;
		activeOnChangeRef.current = onChange;
		setDraft(propDraft);
		currentDraftRef.current = propDraft;
		lastPropSnapshotRef.current = propSnapshot;
		lastEmittedSnapshotRef.current = propSnapshot;
	}, [contentKey, flushPendingDraft, onChange, propDraft, propSnapshot]);

	React.useEffect(() => {
		return () => {
			flushPendingDraft();
		};
	}, [flushPendingDraft]);

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

	React.useEffect(() => {
		clearPendingTextFlush();

		const nextSnapshot = serializeDraft(currentDraftRef.current);
		if (nextSnapshot === lastEmittedSnapshotRef.current) {
			return;
		}

		pendingTextFlushTimerRef.current = setTimeout(() => {
			pendingTextFlushTimerRef.current = null;
			emitChange(currentDraftRef.current);
		}, SEO_TEXT_DEBOUNCE_MS);

		return clearPendingTextFlush;
	}, [clearPendingTextFlush, draft.canonical, draft.description, draft.title, emitChange]);

	const updateDraft = (patch: Partial<SeoDraft>) => {
		const nextDraft = { ...currentDraftRef.current, ...patch };
		currentDraftRef.current = nextDraft;
		setDraft(nextDraft);
		return nextDraft;
	};

	return (
		<div className="space-y-3">
			<Input
				label={t`SEO Title`}
				description={t`Overrides the page title in search engine results`}
				value={draft.title}
				onChange={(e) => {
					updateDraft({ title: e.target.value });
				}}
				dir="auto"
			/>

			<div>
				<InputArea
					label={t`Meta Description`}
					description={
						draft.description
							? t`${draft.description.length}/160 characters`
							: t`Brief summary shown below the title in search results`
					}
					value={draft.description}
					onChange={(e) => {
						updateDraft({ description: e.target.value });
					}}
					rows={3}
					dir="auto"
				/>
			</div>

			<Input
				label={t`Canonical URL`}
				description={t`Points search engines to the original version of this page, if it's duplicated from another URL`}
				value={draft.canonical}
				onChange={(e) => {
					updateDraft({ canonical: e.target.value });
				}}
			/>

			<div className="flex items-center justify-between pt-1">
				<div>
					<Label>{t`Hide from search engines`}</Label>
					<p className="text-xs text-kumo-subtle">{t`Add noindex meta tag`}</p>
				</div>
				<Switch
					checked={draft.noIndex}
					onCheckedChange={(checked) => {
						emitChange(updateDraft({ noIndex: checked }));
					}}
				/>
			</div>
		</div>
	);
}
