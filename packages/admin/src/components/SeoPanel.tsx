/**
 * SEO Panel for Content Editor Sidebar
 *
 * Shows SEO metadata fields (OG image, title, description, canonical URL,
 * noIndex) when the collection has `hasSeo` enabled. Changes are sent
 * alongside content updates via the `seo` field on the update body.
 */

import { Input, InputArea, Switch } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { ContentSeo, ContentSeoInput } from "../lib/api";
import { FieldHelpLabel } from "./FieldHelpLabel.js";
import { SeoImageField } from "./SeoImageField";

export interface SeoPanelProps {
	contentKey: string;
	seo?: ContentSeo;
	/** May resolve to whether the change saved. A room sends a value that didn't with the next change. */
	onChange: (seo: ContentSeoInput) => void | Promise<boolean>;
	/** Title `getSeoMeta` uses when this panel has none, shown as placeholder text. */
	defaultTitle?: string | null;
	/** Description `getSeoMeta` uses when this panel has none, shown as placeholder text. */
	defaultDescription?: string | null;
	/**
	 * In a co-editing room, `onChange` gets only the values changed since this panel last sent or
	 * loaded them, and a value saved elsewhere replaces each one not changed here since.
	 */
	inRoom?: boolean;
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

const DRAFT_KEYS = ["title", "description", "canonical", "noIndex"] as const;

function copyKey<K extends keyof SeoDraft>(target: SeoDraft, source: SeoDraft, key: K): void {
	target[key] = source[key];
}

function changedInput(draft: SeoDraft, sent: SeoDraft): ContentSeoInput {
	const input = toInput(draft);
	return Object.fromEntries(
		DRAFT_KEYS.filter((key) => draft[key] !== sent[key]).map((key) => [key, input[key]]),
	);
}

export function SeoPanel({
	contentKey,
	seo,
	onChange,
	defaultTitle,
	defaultDescription,
	inRoom = false,
}: SeoPanelProps) {
	const { t } = useLingui();
	const titleId = React.useId();
	const descriptionId = React.useId();
	const canonicalId = React.useId();
	const propDraft = React.useMemo(() => toDraft(seo), [seo]);
	const propSnapshot = React.useMemo(() => serializeDraft(propDraft), [propDraft]);
	const [draft, setDraft] = React.useState<SeoDraft>(propDraft);
	const currentDraftRef = React.useRef(draft);
	currentDraftRef.current = draft;
	const lastPropDraftRef = React.useRef(propDraft);
	const lastEmittedDraftRef = React.useRef(propDraft);
	const activeContentKeyRef = React.useRef(contentKey);
	const activeOnChangeRef = React.useRef(onChange);
	const inRoomRef = React.useRef(inRoom);
	inRoomRef.current = inRoom;
	const pendingTextFlushTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	const emitChange = React.useCallback((nextDraft: SeoDraft) => {
		const lastEmitted = lastEmittedDraftRef.current;
		if (serializeDraft(nextDraft) === serializeDraft(lastEmitted)) {
			return;
		}
		lastEmittedDraftRef.current = nextDraft;
		const sent = inRoomRef.current ? changedInput(nextDraft, lastEmitted) : toInput(nextDraft);
		void activeOnChangeRef.current(sent)?.then((saved) => {
			if (saved) return undefined;
			const emitted = { ...lastEmittedDraftRef.current };
			for (const key of DRAFT_KEYS) {
				if (key in sent && emitted[key] === nextDraft[key]) copyKey(emitted, lastEmitted, key);
			}
			lastEmittedDraftRef.current = emitted;
			return undefined;
		});
	}, []);

	const clearPendingTextFlush = React.useCallback(() => {
		if (pendingTextFlushTimerRef.current) {
			clearTimeout(pendingTextFlushTimerRef.current);
			pendingTextFlushTimerRef.current = null;
		}
	}, []);

	const flushPendingDraft = React.useCallback(() => {
		const nextDraft = currentDraftRef.current;
		const nextSnapshot = serializeDraft(nextDraft);
		clearPendingTextFlush();
		if (nextSnapshot === serializeDraft(lastEmittedDraftRef.current)) {
			return;
		}
		emitChange(nextDraft);
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
		lastPropDraftRef.current = propDraft;
		lastEmittedDraftRef.current = propDraft;
	}, [contentKey, flushPendingDraft, onChange, propDraft]);

	React.useEffect(() => {
		return () => {
			flushPendingDraft();
		};
	}, [flushPendingDraft]);

	React.useEffect(() => {
		const previousPropDraft = lastPropDraftRef.current;
		const previousPropSnapshot = serializeDraft(previousPropDraft);
		if (propSnapshot === previousPropSnapshot) {
			return;
		}
		lastPropDraftRef.current = propDraft;

		if (inRoomRef.current) {
			const current = currentDraftRef.current;
			const nextDraft = { ...current };
			const emitted = { ...lastEmittedDraftRef.current };
			for (const key of DRAFT_KEYS) {
				if (propDraft[key] === previousPropDraft[key]) continue;
				if (current[key] === emitted[key]) copyKey(nextDraft, propDraft, key);
				if (nextDraft[key] === propDraft[key]) copyKey(emitted, propDraft, key);
			}
			lastEmittedDraftRef.current = emitted;
			currentDraftRef.current = nextDraft;
			setDraft(nextDraft);
			return;
		}

		const currentDraftSnapshot = serializeDraft(currentDraftRef.current);
		const shouldSync =
			currentDraftSnapshot === previousPropSnapshot || currentDraftSnapshot === propSnapshot;

		if (shouldSync) {
			setDraft(propDraft);
			currentDraftRef.current = propDraft;
			lastEmittedDraftRef.current = propDraft;
		}
	}, [propDraft, propSnapshot]);

	React.useEffect(() => {
		clearPendingTextFlush();

		const nextSnapshot = serializeDraft(currentDraftRef.current);
		if (nextSnapshot === serializeDraft(lastEmittedDraftRef.current)) {
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
		<div className="space-y-4">
			<SeoImageField key={contentKey} seo={seo} onChange={onChange} />

			<div className="space-y-2">
				<FieldHelpLabel
					help={t`Overrides the page title in search engine results`}
					helpLabel={t`Why is this important for search result titles?`}
					htmlFor={titleId}
				>
					{t`SEO Title`}
				</FieldHelpLabel>
				<Input
					id={titleId}
					aria-label={t`SEO Title`}
					className="w-full"
					value={draft.title}
					placeholder={defaultTitle ?? undefined}
					onChange={(e) => {
						updateDraft({ title: e.target.value });
					}}
					dir="auto"
				/>
			</div>

			<div className="space-y-2">
				<FieldHelpLabel
					help={t`Brief summary shown below the title in search results`}
					helpLabel={t`Why is this important for search result summaries?`}
					htmlFor={descriptionId}
				>
					{t`Meta Description`}
				</FieldHelpLabel>
				<InputArea
					id={descriptionId}
					aria-label={t`Meta Description`}
					aria-describedby={`${descriptionId}-count`}
					className="w-full"
					value={draft.description}
					placeholder={defaultDescription ?? undefined}
					onChange={(e) => {
						updateDraft({ description: e.target.value });
					}}
					rows={3}
					dir="auto"
				/>
				<p id={`${descriptionId}-count`} className="text-xs leading-4 text-kumo-subtle">
					{t`${draft.description.length}/160 characters`}
				</p>
			</div>

			<div className="space-y-2">
				<FieldHelpLabel
					help={t`Points search engines to the original version of this page, if it's duplicated from another URL`}
					helpLabel={t`Why is this important for duplicate pages?`}
					htmlFor={canonicalId}
				>
					{t`Canonical URL`}
				</FieldHelpLabel>
				<Input
					dir="ltr"
					id={canonicalId}
					aria-label={t`Canonical URL`}
					className="w-full"
					value={draft.canonical}
					onChange={(e) => {
						updateDraft({ canonical: e.target.value });
					}}
				/>
			</div>

			<div className="flex items-center justify-between">
				<FieldHelpLabel
					help={t`Add noindex meta tag`}
					helpLabel={t`Why is this important for search visibility?`}
				>
					{t`Hide from search engines`}
				</FieldHelpLabel>
				<Switch
					aria-label={t`Hide from search engines`}
					checked={draft.noIndex}
					onCheckedChange={(checked) => {
						emitChange(updateDraft({ noIndex: checked }));
					}}
				/>
			</div>
		</div>
	);
}
