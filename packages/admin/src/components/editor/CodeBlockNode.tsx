/**
 * Code block node with language picker.
 *
 * Wraps the Lowlight code block with a React node view that
 * overlays a Kumo action toolbar at the logical end of the block. The toolbar
 * opens a searchable language popover and copies the raw code. The selected
 * language is persisted on the node's `language` attribute and round-trips
 * through Portable Text as `block.language`.
 *
 * The picker accepts arbitrary strings (not restricted to the curated list)
 * so that less common languages can still be used. Free-form input is
 * sanitized to a single safe CSS class token via `normalizeLanguage` so the
 * frontend's `language-{id}` class stays well-formed.
 *
 * Kumo's `Popover` portals the search input out of the contentEditable DOM so
 * ProseMirror does not interpret input typing as an editor selection change.
 */

import { CommandPalette, Popover, Toolbar, Tooltip, TooltipProvider } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, Check, Copy } from "@phosphor-icons/react";
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

interface LanguageItem {
	id: string;
	label: string;
	aliases?: string[];
}

async function copyTextToClipboard(text: string): Promise<void> {
	if (navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return;
		} catch {}
	}

	const activeElement = document.activeElement;
	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.readOnly = true;
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	document.body.append(textarea);
	const selection = document.getSelection();
	const previousRange = selection?.rangeCount ? selection.getRangeAt(0) : null;
	textarea.select();
	try {
		if (!document.execCommand("copy")) throw new Error("Clipboard copy failed");
	} finally {
		textarea.remove();
		if (previousRange) {
			selection?.removeAllRanges();
			selection?.addRange(previousRange);
		}
		if (activeElement instanceof HTMLElement && activeElement.isConnected) {
			activeElement.focus();
		}
	}
}

function CodeBlockNodeView({ node, updateAttributes }: NodeViewProps) {
	const { t } = useLingui();
	const [isEditing, setIsEditing] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	const [keyboardHighlightedLanguage, setKeyboardHighlightedLanguage] =
		React.useState<LanguageItem | null>(null);
	const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
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
			CODE_BLOCK_LANGUAGES.map((language) => ({
				id: language.id,
				label: t(language.label),
				aliases: language.aliases,
			})),
		[t],
	);

	const findLanguageByDisplayLabel = React.useCallback(
		(label: string) => languageItems.find((language) => language.label === label),
		[languageItems],
	);

	const filterLanguages = React.useCallback((item: LanguageItem, query: string) => {
		if (!query) return true;
		const searchText = query.toLowerCase();
		if (item.label.toLowerCase().includes(searchText)) return true;
		if (item.id.toLowerCase().includes(searchText)) return true;
		return item.aliases?.some((alias) => alias.toLowerCase().includes(searchText)) ?? false;
	}, []);

	React.useEffect(
		() => () => {
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
		},
		[],
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
		setDraft("");
		setKeyboardHighlightedLanguage(null);
		setIsEditing(true);
	}, []);

	const closePicker = React.useCallback(() => {
		setIsEditing(false);
		setKeyboardHighlightedLanguage(null);
		setDraft(labelText(storedLanguage));
	}, [storedLanguage, labelText]);

	const commit = React.useCallback(
		(value?: string) => {
			const raw = value ?? draft;
			const selectedLanguage = findLanguageByDisplayLabel(raw);
			const next = selectedLanguage?.id ?? normalizeLanguage(raw);
			updateAttributes({ language: next ?? null });
			setIsEditing(false);
			setKeyboardHighlightedLanguage(null);
		},
		[draft, findLanguageByDisplayLabel, updateAttributes],
	);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") {
			e.preventDefault();
			closePicker();
			return;
		}
		if (e.key === "Enter" && !keyboardHighlightedLanguage) {
			e.preventDefault();
			commit();
		}
	};

	const copyCode = React.useCallback(async () => {
		try {
			await copyTextToClipboard(node.textContent);
			setCopied(true);
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
			copyResetTimer.current = setTimeout(setCopied, 1500, false);
		} catch {
			setCopied(false);
		}
	}, [node.textContent]);

	const label = labelText(storedLanguage);
	const currentLanguageId = normalizeLanguage(storedLanguage);
	const controlsPersistent = isEditing || copied;

	return (
		<NodeViewWrapper
			className="emdash-code-block-node relative my-4"
			data-language={storedLanguage || undefined}
		>
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div className="absolute end-1 top-1 z-10 select-none" contentEditable={false}>
				<Popover
					open={isEditing}
					onOpenChange={(open: boolean) => (open ? openPicker() : closePicker())}
				>
					<TooltipProvider>
						<Toolbar
							size="base"
							className="emdash-code-block-controls text-base"
							data-persistent={controlsPersistent ? "true" : "false"}
							aria-label={t`Code block actions`}
						>
							<Popover.Trigger
								render={
									<Toolbar.Button
										className="gap-1.5 text-base"
										onMouseDown={(event) => event.preventDefault()}
										aria-label={t`Set language (current: ${label})`}
									>
										<span className="max-w-40 truncate">{label}</span>
										<CaretDown className="size-3.5 shrink-0 text-kumo-subtle" aria-hidden="true" />
									</Toolbar.Button>
								}
							/>
							<Tooltip
								content={copied ? t`Copied` : t`Copy code`}
								render={
									<Toolbar.Button
										shape="square"
										className="relative isolate size-9 overflow-hidden text-base"
										onMouseDown={(event) => event.preventDefault()}
										onClick={copyCode}
										aria-label={copied ? t`Copied` : t`Copy code`}
									>
										<span
											className={`absolute inset-0 flex items-center justify-center transition-[transform,opacity] duration-200 motion-reduce:transition-none ${copied ? "translate-y-0 opacity-100" : "translate-y-full opacity-0"}`}
										>
											<Check className="size-4" aria-hidden="true" />
										</span>
										<span
											className={`flex items-center justify-center transition-[transform,opacity] duration-200 motion-reduce:transition-none ${copied ? "-translate-y-full opacity-0" : "translate-y-0 opacity-100"}`}
										>
											<Copy className="size-4" aria-hidden="true" />
										</span>
									</Toolbar.Button>
								}
							/>
						</Toolbar>
					</TooltipProvider>
					<span className="sr-only" role="status" aria-live="polite">
						{copied ? t`Copied` : ""}
					</span>
					<Popover.Content
						side="bottom"
						align="start"
						sideOffset={8}
						positionMethod="fixed"
						className="w-[min(13.5rem,calc(100vw-2rem))] overflow-hidden p-0"
					>
						<CommandPalette.Panel<LanguageItem>
							items={languageItems}
							value={draft}
							onValueChange={(next: string) => {
								setDraft(next);
								setKeyboardHighlightedLanguage(null);
							}}
							onItemHighlighted={(item, details) =>
								setKeyboardHighlightedLanguage(
									details.reason === "keyboard" ? (item ?? null) : null,
								)
							}
							itemToStringValue={(item) => item.label}
							filter={filterLanguages}
							open={isEditing}
							className="max-h-[min(16rem,30vh)] [&>div:first-child]:gap-0 [&>div:first-child]:px-3 [&>div:first-child]:py-3 [&>div:first-child]:focus-within:ring-0"
						>
							<CommandPalette.Input
								aria-label={t`Search for a language`}
								placeholder={t`Search for a language…`}
								leading={<span className="hidden" aria-hidden="true" />}
								autoComplete="off"
								spellCheck={false}
								onKeyDown={handleKeyDown}
								className="h-9 rounded-lg bg-kumo-control px-3 text-base ring ring-kumo-line focus:ring-2 focus:ring-kumo-brand"
							/>
							<CommandPalette.List className="max-h-[min(14rem,25vh)] rounded-t-none text-base">
								<CommandPalette.Results>
									{(item: LanguageItem) => (
										<CommandPalette.Item key={item.id} value={item} onClick={() => commit(item.id)}>
											<span className="flex min-w-0 flex-1 items-center justify-between gap-3">
												<span className="truncate">{item.label}</span>
												{currentLanguageId === item.id ? (
													<Check className="size-4 shrink-0" aria-hidden="true" />
												) : null}
											</span>
										</CommandPalette.Item>
									)}
								</CommandPalette.Results>
								<CommandPalette.Empty>{t`No matches`}</CommandPalette.Empty>
							</CommandPalette.List>
						</CommandPalette.Panel>
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
