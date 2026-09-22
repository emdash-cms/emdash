/**
 * Code block node with language picker.
 *
 * Wraps the Lowlight code block with a React node view that
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

import { Autocomplete, Popover, Toolbar, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, Check, Copy, X } from "@phosphor-icons/react";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { common, createLowlight } from "lowlight";
import * as React from "react";

import {
	CODE_BLOCK_LANGUAGES,
	languageLabelDescriptor,
	normalizeLanguage,
} from "./codeBlockLanguages";

const ADMIN_CODE_BLOCK_LOWLIGHT_KEY = Symbol.for("emdash:admin-code-block-lowlight");
const globalStore = globalThis as Record<symbol, unknown>;
const lowlight =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
	(globalStore[ADMIN_CODE_BLOCK_LOWLIGHT_KEY] as ReturnType<typeof createLowlight> | undefined) ??
	(() => {
		const instance = createLowlight(common);
		instance.register({ dockerfile });
		globalStore[ADMIN_CODE_BLOCK_LOWLIGHT_KEY] = instance;
		return instance;
	})();

const editorLowlight = {
	highlight(language: string, value: string) {
		return lowlight.highlight(lowlight.registered(language) ? language : "plaintext", value);
	},
	highlightAuto(value: string) {
		return lowlight.highlight("plaintext", value);
	},
	listLanguages() {
		return lowlight.listLanguages();
	},
	registered(language: string) {
		return lowlight.registered(language);
	},
};

async function copyTextToClipboard(text: string, shouldUseFallback: () => boolean): Promise<void> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {}
	}
	if (!shouldUseFallback()) return;
	const activeElement = document.activeElement;
	const selection = document.getSelection();
	const previousRange = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.readOnly = true;
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	textarea.select();
	try {
		if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
	} finally {
		textarea.remove();
		if (activeElement instanceof HTMLElement && activeElement.isConnected) activeElement.focus();
		if (previousRange) {
			selection?.removeAllRanges();
			selection?.addRange(previousRange);
		}
	}
}

function CodeBlockNodeView({ node, updateAttributes }: NodeViewProps) {
	const { t } = useLingui();
	const [isEditing, setIsEditing] = React.useState(false);
	const [copyStatus, setCopyStatus] = React.useState<"idle" | "copied" | "failed">("idle");
	const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const copyRequestId = React.useRef(0);
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";

	const labelText = React.useCallback(
		(value: string | null | undefined) => {
			const label = languageLabelDescriptor(value);
			return typeof label === "string" ? label : t(label);
		},
		[t],
	);

	const languageItems = React.useMemo(
		() =>
			CODE_BLOCK_LANGUAGES.map((language) => t(language.label)).toSorted((a, b) =>
				a.localeCompare(b),
			),
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
	const hasLanguageMatches = React.useMemo(
		() => languageItems.some((item) => filterLanguages(item, draft.trim())),
		[draft, filterLanguages, languageItems],
	);
	const freeFormLanguage = hasLanguageMatches ? undefined : normalizeLanguage(draft);

	const openPicker = React.useCallback(() => {
		setDraft("");
		setIsEditing(true);
	}, []);

	const closePicker = React.useCallback(() => {
		setIsEditing(false);
	}, []);

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

	// Enter commits a free-form value when no suggestion is active. The
	// autocomplete handles highlighted suggestions and Escape.
	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Enter" && !e.defaultPrevented && e.target instanceof HTMLInputElement) {
			e.preventDefault();
			commit();
		}
	};
	const copyCode = React.useCallback(async () => {
		const requestId = ++copyRequestId.current;
		setCopyStatus("idle");
		try {
			await copyTextToClipboard(node.textContent, () => requestId === copyRequestId.current);
			if (requestId !== copyRequestId.current) return;
			setCopyStatus("copied");
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
			copyResetTimer.current = setTimeout(setCopyStatus, 1500, "idle");
		} catch {
			if (requestId !== copyRequestId.current) return;
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
			setCopyStatus("failed");
		}
	}, [node.textContent]);
	React.useEffect(
		() => () => {
			copyRequestId.current += 1;
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
		},
		[],
	);

	const label = labelText(storedLanguage);
	const copied = copyStatus === "copied";
	const copyFailed = copyStatus === "failed";

	return (
		<NodeViewWrapper
			className="emdash-code-block-node relative my-4"
			data-language={storedLanguage || undefined}
		>
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div
				className="absolute end-1 top-0 z-10 select-none"
				style={{ width: "max-content", maxWidth: "calc(100% - 0.25rem)" }}
				contentEditable={false}
			>
				<Popover
					open={isEditing}
					onOpenChange={(open: boolean) => (open ? openPicker() : closePicker())}
				>
					<TooltipProvider>
						<Toolbar
							size="sm"
							className="emdash-code-block-controls max-w-full border border-kumo-line text-[13px] ring-0 shadow-none"
							data-persistent={isEditing || copyStatus !== "idle" ? "true" : "false"}
							aria-label={t`Code block actions`}
						>
							<Popover.Trigger
								render={
									<Toolbar.Button
										className="min-w-0 flex-1 overflow-hidden text-[13px] focus:ring-0 focus-visible:relative focus-visible:z-10 focus-visible:bg-kumo-tint focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-focus focus-visible:ring-0"
										onMouseDown={(event) => event.preventDefault()}
										aria-label={t`Set language (current: ${label})`}
									>
										<span className="max-w-40 truncate">
											{storedLanguage ? label : t`Set language`}
										</span>
										<CaretDown className="size-3.5 shrink-0" aria-hidden="true" />
									</Toolbar.Button>
								}
							/>
							<Tooltip
								content={copyFailed ? t`Retry copy` : copied ? t`Copied` : t`Copy code`}
								render={
									<Toolbar.Button
										shape="square"
										className="relative isolate overflow-hidden text-[13px]"
										onMouseDown={(event) => event.preventDefault()}
										onClick={copyCode}
										aria-label={copyFailed ? t`Retry copy` : t`Copy code`}
									>
										<span className="contents" aria-hidden="true">
											{copied ? (
												<Check className="size-3.5" />
											) : copyFailed ? (
												<X className="size-3.5" />
											) : (
												<Copy className="size-3.5" />
											)}
										</span>
									</Toolbar.Button>
								}
							/>
						</Toolbar>
					</TooltipProvider>
					<span className="sr-only" role="status" aria-live="polite">
						{copyFailed ? t`Copy failed` : copied ? t`Copied` : ""}
					</span>
					<Popover.Content
						side="bottom"
						className="emdash-code-language-popover z-[100] max-h-[var(--available-height)] w-80 max-w-[calc(100vw-1rem)] overflow-hidden p-3"
					>
						<Autocomplete
							inline
							label={t`Language`}
							open={isEditing}
							onOpenChange={(open: boolean) => {
								if (!open) closePicker();
							}}
							items={languageItems}
							value={draft}
							onValueChange={(next: string) => setDraft(next)}
							filter={filterLanguages}
						>
							<div onKeyDown={handleKeyDown}>
								<Autocomplete.InputGroup
									size="base"
									className="emdash-code-language-input border border-kumo-line ring-0 focus:ring-0"
									placeholder={t`Search for a language…`}
								/>
							</div>
							<Autocomplete.List className="emdash-code-language-list mt-2 max-h-[min(20rem,calc(var(--available-height)-6rem))]">
								{(item: string) => {
									const isCurrentLanguage = Boolean(storedLanguage) && item === label;
									return (
										<Autocomplete.Item
											key={item}
											value={item}
											aria-selected={isCurrentLanguage}
											data-selected={isCurrentLanguage ? "" : undefined}
											onClick={() => commit(item)}
										>
											{item}
										</Autocomplete.Item>
									);
								}}
							</Autocomplete.List>
							<Autocomplete.Empty
								className={hasLanguageMatches ? undefined : "px-3 py-2 text-base text-kumo-subtle"}
							>
								{freeFormLanguage
									? t`No matches. Press Enter to use “${freeFormLanguage}”.`
									: t`No matches`}
							</Autocomplete.Empty>
						</Autocomplete>
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
export const CodeBlockExtension = CodeBlockLowlight.extend({
	addKeyboardShortcuts() {
		const shortcuts = this.parent?.() ?? {};
		const selectionIsInCodeBlock = () => {
			const { $from, $to } = this.editor.state.selection;
			return $from.parent.type === this.type && $from.sameParent($to);
		};

		return {
			...shortcuts,
			Tab: (props) => (selectionIsInCodeBlock() ? (shortcuts.Tab?.(props) ?? false) : false),
			"Shift-Tab": (props) =>
				selectionIsInCodeBlock() ? (shortcuts["Shift-Tab"]?.(props) ?? false) : false,
		};
	},
	addNodeView() {
		return ReactNodeViewRenderer(CodeBlockNodeView);
	},
}).configure({
	lowlight: editorLowlight,
	defaultLanguage: "plaintext",
	enableTabIndentation: true,
	tabSize: 4,
});
