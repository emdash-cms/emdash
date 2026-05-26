/**
 * Code block node with language picker.
 *
 * Wraps the base `@tiptap/extension-code-block` with a React node view that
 * overlays a small language chip in the top-right corner. Clicking the chip
 * opens a popover with a free-form input plus a datalist of curated
 * language suggestions. The value is persisted on the node's `language`
 * attribute and round-trips through Portable Text as `block.language`.
 *
 * The picker accepts arbitrary strings (not restricted to the curated list)
 * so that less common languages can still be used. Free-form input is
 * normalized to lowercase via `normalizeLanguage` to keep `language-{id}`
 * CSS classes stable.
 */

import { Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Check, X } from "@phosphor-icons/react";
import CodeBlock from "@tiptap/extension-code-block";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

import { CODE_BLOCK_LANGUAGES, languageLabel, normalizeLanguage } from "./codeBlockLanguages";

const DATALIST_ID = "emdash-code-block-languages";

function CodeBlockLanguageDatalist() {
	return (
		<datalist id={DATALIST_ID}>
			{CODE_BLOCK_LANGUAGES.map((lang) => (
				<option key={lang.id} value={lang.id} label={lang.label} />
			))}
		</datalist>
	);
}

function CodeBlockNodeView({ node, updateAttributes, selected }: NodeViewProps) {
	const { t } = useLingui();
	const [isEditing, setIsEditing] = React.useState(false);
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [draft, setDraft] = React.useState(storedLanguage);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const popoverRef = React.useRef<HTMLDivElement>(null);

	// Sync draft when the stored language changes from outside the node view
	// (e.g. another collaborator edits the attribute, or the editor reloads
	// content). Don't clobber an in-progress edit.
	React.useEffect(() => {
		if (!isEditing) {
			setDraft(storedLanguage);
		}
	}, [storedLanguage, isEditing]);

	const openPicker = React.useCallback(() => {
		setDraft(storedLanguage);
		setIsEditing(true);
		// Focus after state update so the input exists in the DOM.
		setTimeout(() => inputRef.current?.focus(), 0);
	}, [storedLanguage]);

	const closePicker = React.useCallback(() => {
		setIsEditing(false);
		setDraft(storedLanguage);
	}, [storedLanguage]);

	const commit = React.useCallback(() => {
		const next = normalizeLanguage(draft);
		updateAttributes({ language: next ?? null });
		setIsEditing(false);
	}, [draft, updateAttributes]);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Enter") {
			e.preventDefault();
			commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			closePicker();
		}
	};

	// Close on outside click while the popover is open.
	React.useEffect(() => {
		if (!isEditing) return undefined;
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target instanceof Node ? event.target : null;
			if (popoverRef.current && target && !popoverRef.current.contains(target)) {
				closePicker();
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [isEditing, closePicker]);

	const label = languageLabel(storedLanguage);
	// Chip is always rendered (so it can be discovered via hover) but its
	// opacity is controlled by CSS: invisible by default, visible on hover,
	// when this block is selected, when the picker is open, or when the
	// block already has a language set.
	const chipPersistent = isEditing || Boolean(storedLanguage) || selected;

	return (
		<NodeViewWrapper className="relative my-4 group" data-language={storedLanguage || undefined}>
			<CodeBlockLanguageDatalist />
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div className="absolute top-2 end-2 select-none" contentEditable={false}>
				{isEditing ? (
					<div
						ref={popoverRef}
						className="flex items-center gap-1 rounded-md border bg-kumo-overlay p-1 shadow-lg"
					>
						<Input
							ref={inputRef}
							type="text"
							list={DATALIST_ID}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder={t`Language`}
							aria-label={t`Language`}
							className="h-7 w-40 text-xs"
						/>
						<Button
							type="button"
							variant="ghost"
							shape="square"
							className="h-7 w-7"
							onMouseDown={(e) => e.preventDefault()}
							onClick={commit}
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
				) : (
						<button
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={openPicker}
							className="rounded-md border bg-kumo-overlay/90 px-2 py-1 text-xs text-kumo-subtle opacity-0 transition-opacity hover:text-kumo-strong group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-2 focus:ring-kumo-brand data-[persistent=true]:opacity-100"
							data-persistent={chipPersistent ? "true" : "false"}
							title={t`Set language`}
							aria-label={t`Set language (current: ${label})`}
						>
							{storedLanguage ? label : t`Set language`}
						</button>
				)}
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
