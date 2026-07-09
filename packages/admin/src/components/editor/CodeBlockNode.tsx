/**
 * Code block node with language picker.
 *
 * Wraps the base `@tiptap/extension-code-block` with a React node view that
 * overlays a small language chip in the top-right corner. Clicking the chip
 * opens a popover with a Kumo Autocomplete: a free-form text input plus a
 * filtered list of curated language suggestions. The value is persisted on
 * the node's `language` attribute and round-trips through Portable Text as
 * `block.language`.
 *
 * The picker accepts arbitrary strings (not restricted to the curated list)
 * so that less common languages can still be used. Free-form input is
 * sanitized to a single safe CSS class token via `normalizeLanguage` so the
 * frontend's `language-{id}` class stays well-formed.
 *
 * The popover content is rendered through Kumo's `Popover`, which portals it
 * out of the editor's contentEditable DOM. That portal is load-bearing, not
 * cosmetic: a code block is a non-atom ProseMirror node with live editable
 * content, so if the picker's text input lived inside the node view, typing
 * would move the DOM selection into it. ProseMirror reads that selection,
 * dispatches a selection-correcting transaction, and the resulting node-view
 * redraw recreates this React component mid-edit, tearing the picker down --
 * the "language picker loses focus and closes when you type" bug (issue
 * #1200). Keeping the input outside the editor DOM avoids it entirely.
 */

import { Autocomplete, Button, Popover } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, X } from "@phosphor-icons/react";
import CodeBlock from "@tiptap/extension-code-block";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import {
	CODE_BLOCK_LANGUAGES,
	languageLabelDescriptor,
	normalizeLanguage,
} from "./codeBlockLanguages";

function CodeBlockNodeView({ node, updateAttributes, selected }: NodeViewProps) {
	const { t } = useLingui();
	const [isEditing, setIsEditing] = React.useState(false);
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";

	const labelText = React.useCallback(
		(value: string | null | undefined) => {
			const label = languageLabelDescriptor(value);
			return typeof label === "string" ? label : t(label);
		},
		[t],
	);

	const languageItems = React.useMemo(
		() => CODE_BLOCK_LANGUAGES.map((language) => t(language.label)),
		[t],
	);

	const findLanguageByDisplayLabel = React.useCallback(
		(label: string) => CODE_BLOCK_LANGUAGES.find((language) => t(language.label) === label),
		[t],
	);

	const filterLanguages = React.useCallback(
		(item: string, query: string) => {
			if (!query) return true;
			const searchText = query.toLowerCase();
			const lang = findLanguageByDisplayLabel(item);
			if (!lang) return false;

			if (t(lang.label).toLowerCase().includes(searchText)) return true;
			if (lang.id.toLowerCase().includes(searchText)) return true;
			return lang.aliases?.some((alias) => alias.toLowerCase().includes(searchText)) ?? false;
		},
		[findLanguageByDisplayLabel, t],
	);

	const [draft, setDraft] = React.useState(() => labelText(storedLanguage));

	// Sync draft when the stored language changes from outside the node view
	// (e.g. another collaborator edits the attribute, or the editor reloads
	// content). Don't clobber an in-progress edit.
	React.useEffect(() => {
		if (!isEditing) {
			setDraft(labelText(storedLanguage));
		}
	}, [storedLanguage, isEditing, labelText]);

	const openPicker = React.useCallback(() => {
		setDraft(storedLanguage ? labelText(storedLanguage) : "");
		setIsEditing(true);
	}, [storedLanguage, labelText]);

	const closePicker = React.useCallback(() => {
		setIsEditing(false);
		setDraft(labelText(storedLanguage));
	}, [storedLanguage, labelText]);

	const commit = React.useCallback(
		(value?: string) => {
			const raw = value ?? draft;
			const selectedLanguage = findLanguageByDisplayLabel(raw);
			const next = selectedLanguage?.id ?? normalizeLanguage(raw);
			updateAttributes({ language: next ?? null });
			setIsEditing(false);
		},
		[draft, findLanguageByDisplayLabel, updateAttributes],
	);

	// Enter commits the current draft. Escape is handled by the Popover itself
	// (it calls onOpenChange(false) -> closePicker).
	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		}
	};

	const label = labelText(storedLanguage);
	// The chip is always rendered (so it can be discovered via hover) but its
	// opacity is controlled by CSS: invisible by default, visible on hover,
	// when this block is selected, when the picker is open, or when the
	// block already has a language set. When hidden, also remove it from the
	// tab order so it doesn't trap keyboard focus.
	const chipPersistent = isEditing || Boolean(storedLanguage) || selected;

	return (
		<NodeViewWrapper className="group relative my-4" data-language={storedLanguage || undefined}>
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div className="absolute end-2 top-2 select-none" contentEditable={false}>
				<Popover
					open={isEditing}
					onOpenChange={(open: boolean) => (open ? openPicker() : closePicker())}
				>
					<Popover.Trigger
						render={
							<button
								type="button"
								tabIndex={chipPersistent ? 0 : -1}
								onMouseDown={(e) => e.preventDefault()}
								className="rounded-md border bg-kumo-overlay/90 px-2 py-1 text-xs text-kumo-subtle opacity-0 transition-opacity hover:text-kumo-strong focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-kumo-brand group-hover:opacity-100 data-[persistent=true]:opacity-100"
								data-persistent={chipPersistent ? "true" : "false"}
								title={t`Set language`}
								aria-label={t`Set language (current: ${label})`}
								aria-hidden={chipPersistent ? undefined : true}
							>
								{storedLanguage ? label : t`Set language`}
							</button>
						}
					/>
					<Popover.Content side="bottom" className="w-auto p-1">
						<div className="flex items-center gap-1" onKeyDown={handleKeyDown}>
							<Autocomplete
								items={languageItems}
								value={draft}
								onValueChange={(next: string) => setDraft(next)}
								filter={filterLanguages}
							>
								<Autocomplete.InputGroup size="sm" placeholder={t`Language`} />
								<Autocomplete.Content sideOffset={4}>
									<Autocomplete.List>
										{(item: string) => (
											<Autocomplete.Item key={item} value={item}>
												{item}
											</Autocomplete.Item>
										)}
									</Autocomplete.List>
									<Autocomplete.Empty>{t`No matches`}</Autocomplete.Empty>
								</Autocomplete.Content>
							</Autocomplete>
							<Button
								type="button"
								variant="ghost"
								shape="square"
								className="h-7 w-7"
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => commit()}
								title={t`Apply language`}
								aria-label={t`Apply language`}
							>
								<Check className="h-4 w-4" />
							</Button>
							<Button
								type="button"
								variant="ghost"
								shape="square"
								className="h-7 w-7"
								onMouseDown={(e) => e.preventDefault()}
								onClick={closePicker}
								title={t`Cancel`}
								aria-label={t`Cancel`}
							>
								<X className="h-4 w-4" />
							</Button>
						</div>
					</Popover.Content>
				</Popover>
			</div>
		</NodeViewWrapper>
	);
}

/**
 * TipTap extension: code block with an inline language picker node view.
 *
 * Drop-in replacement for StarterKit's default `codeBlock`. Configure
 * `StarterKit.configure({ codeBlock: false })` and add this extension to
 * the editor's extensions array.
 */
export const CodeBlockExtension = CodeBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(CodeBlockNodeView);
	},
});
