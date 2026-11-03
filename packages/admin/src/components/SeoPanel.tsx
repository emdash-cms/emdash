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

/** The SEO title and description as SeoPanel holds them: "" for none. */
export interface SeoText {
	title: string;
	description: string;
}

/**
 * The editor's copy of one entry's SEO title and description, which outlives SeoPanel.
 * ContentEditor creates one per entry, reads `text`, and reports the entry's saved text
 * through `adoptSavedSeoText`. A mounted SeoPanel keeps `text` current and attaches
 * `setText`. Text in `text` while no panel is attached has been sent: the panel sends
 * pending text when it detaches, and the editor saves at once any text it writes while
 * no panel is attached.
 */
export interface SeoTextBridge {
	text: SeoText;
	/** The entry's saved text as last reported. */
	base: SeoText;
	/** Set while a SeoPanel shows the entry: writes text the way typing does. */
	setText: ((text: Partial<SeoText>) => void) | null;
}

export function createSeoTextBridge(seo: ContentSeo | undefined): SeoTextBridge {
	const text = { title: seo?.title ?? "", description: seo?.description ?? "" };
	return { text, base: text, setText: null };
}

/**
 * Records the entry's saved text. While no panel is attached, `text` follows it only if `text`
 * still matches the previous saved text, the rule SeoPanel uses to adopt a new `seo` prop.
 * Other text has been sent and may not be saved yet.
 */
export function adoptSavedSeoText(bridge: SeoTextBridge, saved: SeoText): void {
	const previous = bridge.base;
	bridge.base = saved;
	if (
		!bridge.setText &&
		bridge.text.title === previous.title &&
		bridge.text.description === previous.description
	) {
		bridge.text = saved;
	}
}

/** The SEO save for text written while no panel is attached. Columns it leaves out keep their stored value. */
export function seoTextInput(text: Partial<SeoText>): ContentSeoInput {
	return {
		...(text.title !== undefined && { title: text.title || null }),
		...(text.description !== undefined && { description: text.description || null }),
	};
}

export interface SeoPanelProps {
	contentKey: string;
	seo?: ContentSeo;
	onChange: (seo: ContentSeoInput) => void;
	/** Title `getSeoMeta` uses when this panel has none, shown as placeholder text. */
	defaultTitle?: string | null;
	/** Description `getSeoMeta` uses when this panel has none, shown as placeholder text. */
	defaultDescription?: string | null;
	/** The editor's copy of this entry's title and description. The panel starts from it and keeps it current. */
	textBridge?: SeoTextBridge;
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

function withBridgeText(draft: SeoDraft, bridge: SeoTextBridge | undefined): SeoDraft {
	return bridge ? { ...draft, ...bridge.text } : draft;
}

export function SeoPanel({
	contentKey,
	seo,
	onChange,
	defaultTitle,
	defaultDescription,
	textBridge,
}: SeoPanelProps) {
	const { t } = useLingui();
	const titleId = React.useId();
	const descriptionId = React.useId();
	const canonicalId = React.useId();
	const propDraft = React.useMemo(() => toDraft(seo), [seo]);
	const propSnapshot = React.useMemo(() => serializeDraft(propDraft), [propDraft]);
	const [draft, setDraft] = React.useState<SeoDraft>(() => withBridgeText(propDraft, textBridge));
	const currentDraftRef = React.useRef(draft);
	currentDraftRef.current = draft;
	const lastPropSnapshotRef = React.useRef(propSnapshot);
	// Text the panel starts from has been sent, whether it came from the entry or the bridge.
	const lastEmittedSnapshotRef = React.useRef(serializeDraft(draft));
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
		const nextDraft = currentDraftRef.current;
		const nextSnapshot = serializeDraft(nextDraft);
		clearPendingTextFlush();
		if (nextSnapshot === lastEmittedSnapshotRef.current) {
			return;
		}
		emitChange(nextDraft);
	}, [clearPendingTextFlush, emitChange]);

	const updateDraft = React.useCallback(
		(patch: Partial<SeoDraft>) => {
			const nextDraft = { ...currentDraftRef.current, ...patch };
			currentDraftRef.current = nextDraft;
			if (textBridge) {
				textBridge.text = { title: nextDraft.title, description: nextDraft.description };
			}
			setDraft(nextDraft);
			return nextDraft;
		},
		[textBridge],
	);

	// The entry reset, the flush and the bridge attachment run in one layout effect, so text
	// the editor writes can't land between them and go to the wrong entry or skip the panel.
	React.useLayoutEffect(() => {
		activeOnChangeRef.current = onChange;
		if (activeContentKeyRef.current !== contentKey) {
			activeContentKeyRef.current = contentKey;
			const next = withBridgeText(propDraft, textBridge);
			setDraft(next);
			currentDraftRef.current = next;
			lastPropSnapshotRef.current = propSnapshot;
			lastEmittedSnapshotRef.current = serializeDraft(next);
		}
		const setText = (text: Partial<SeoText>) => void updateDraft(text);
		if (textBridge) textBridge.setText = setText;
		return () => {
			// Pending text goes to the entry and through the onChange it was typed under.
			flushPendingDraft();
			if (textBridge?.setText === setText) textBridge.setText = null;
		};
	}, [contentKey, flushPendingDraft, onChange, textBridge, updateDraft]);

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
			if (textBridge) {
				textBridge.text = { title: propDraft.title, description: propDraft.description };
			}
		}

		lastPropSnapshotRef.current = propSnapshot;
	}, [propDraft, propSnapshot, textBridge]);

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
