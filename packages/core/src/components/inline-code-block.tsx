/**
 * Code block node view for the inline (visual editing) Portable Text editor.
 *
 * Mirrors the admin editor's `CodeBlockNode` but with no Kumo/Lingui deps,
 * so it can ship as part of the SSR runtime. Wraps the Lowlight code block and
 * overlays matching language and copy controls at the logical end of each code
 * block.
 *
 * Keep the language list in sync with
 * `packages/admin/src/components/editor/codeBlockLanguages.ts`. Duplicated
 * here so packages/core stays independent of the admin package.
 */

import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import { common, createLowlight } from "lowlight";
import * as React from "react";

const INLINE_CODE_BLOCK_LOWLIGHT_KEY = Symbol.for("emdash:inline-code-block-lowlight");
const globalStore = globalThis as Record<symbol, unknown>;
const lowlight =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern
	(globalStore[INLINE_CODE_BLOCK_LOWLIGHT_KEY] as ReturnType<typeof createLowlight> | undefined) ??
	(() => {
		const instance = createLowlight(common);
		instance.register({ dockerfile });
		globalStore[INLINE_CODE_BLOCK_LOWLIGHT_KEY] = instance;
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

interface CodeBlockLanguage {
	id: string;
	label: string;
	aliases?: string[];
}

const CODE_BLOCK_LANGUAGES: readonly CodeBlockLanguage[] = [
	{ id: "plaintext", label: "Plain text", aliases: ["text", "plain", "txt"] },
	{ id: "astro", label: "Astro" },
	{ id: "bash", label: "Bash", aliases: ["sh", "shell", "zsh"] },
	{ id: "c", label: "C" },
	{ id: "cpp", label: "C++", aliases: ["c++"] },
	{ id: "csharp", label: "C#", aliases: ["cs", "c#"] },
	{ id: "css", label: "CSS" },
	{ id: "diff", label: "Diff", aliases: ["patch"] },
	{ id: "dockerfile", label: "Dockerfile", aliases: ["docker"] },
	{ id: "go", label: "Go", aliases: ["golang"] },
	{ id: "graphql", label: "GraphQL", aliases: ["gql"] },
	{ id: "html", label: "HTML" },
	{ id: "java", label: "Java" },
	{ id: "javascript", label: "JavaScript", aliases: ["js"] },
	{ id: "json", label: "JSON" },
	{ id: "jsx", label: "JSX" },
	{ id: "kotlin", label: "Kotlin", aliases: ["kt"] },
	{ id: "markdown", label: "Markdown", aliases: ["md"] },
	{ id: "mdx", label: "MDX" },
	{ id: "php", label: "PHP" },
	{ id: "python", label: "Python", aliases: ["py"] },
	{ id: "ruby", label: "Ruby", aliases: ["rb"] },
	{ id: "rust", label: "Rust", aliases: ["rs"] },
	{ id: "scss", label: "SCSS", aliases: ["sass"] },
	{ id: "sql", label: "SQL" },
	{ id: "svelte", label: "Svelte" },
	{ id: "swift", label: "Swift" },
	{ id: "toml", label: "TOML" },
	{ id: "tsx", label: "TSX" },
	{ id: "typescript", label: "TypeScript", aliases: ["ts"] },
	{ id: "vue", label: "Vue" },
	{ id: "xml", label: "XML" },
	{ id: "yaml", label: "YAML", aliases: ["yml"] },
];

function findLanguage(value: string | null | undefined): CodeBlockLanguage | null {
	if (!value) return null;
	const needle = value.trim().toLowerCase();
	if (!needle) return null;
	for (const lang of CODE_BLOCK_LANGUAGES) {
		if (lang.id === needle) return lang;
		if (lang.aliases?.includes(needle)) return lang;
	}
	return null;
}

// Hoisted to module scope to avoid re-compilation on every call.
const DISALLOWED_CHARS_RE = /[^a-z0-9_-]+/g;
const LEADING_TRAILING_HYPHENS_RE = /^-+|-+$/g;

function normalizeLanguage(value: string | null | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const match = findLanguage(trimmed);
	if (match) return match.id;
	// Sanitize unknown input: lowercase, then collapse runs of disallowed
	// characters into a single `-` so the result is always a single CSS class
	// token (the frontend renders `language-{id}` on the <pre>/<code>).
	const sanitized = trimmed
		.toLowerCase()
		.replace(DISALLOWED_CHARS_RE, "-")
		.replace(LEADING_TRAILING_HYPHENS_RE, "");
	return sanitized || undefined;
}

function languageLabel(value: string | null | undefined): string {
	if (!value) return "Plain text";
	const match = findLanguage(value);
	if (match) return match.label;
	return value;
}

const POPUP_WIDTH = 216;
const POPUP_VIEWPORT_INSET = 16;
const POPUP_OFFSET = 8;

interface PopupPosition {
	left: number;
	maxHeight: number;
	top: number;
	width: number;
}

function CaretDownIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<polyline points="6 9 12 15 18 9" />
		</svg>
	);
}

function CopyIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<rect x="9" y="9" width="11" height="11" rx="2" />
			<path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3" />
		</svg>
	);
}

function CheckIcon() {
	return (
		<svg
			width="16"
			height="16"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
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
	textarea.dataset.emdashClipboardFallback = "";
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

function InlineCodeBlockNodeView({ node, updateAttributes }: NodeViewProps) {
	const [isEditing, setIsEditing] = React.useState(false);
	const [copied, setCopied] = React.useState(false);
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [draft, setDraft] = React.useState("");
	const [activeIndex, setActiveIndex] = React.useState(0);
	const [keyboardNavigated, setKeyboardNavigated] = React.useState(false);
	const [popupPosition, setPopupPosition] = React.useState<PopupPosition | null>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const popoverRef = React.useRef<HTMLDivElement>(null);
	const toolbarRef = React.useRef<HTMLDivElement>(null);
	const languageButtonRef = React.useRef<HTMLButtonElement>(null);
	const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const listboxId = React.useId();

	const filteredLanguages = React.useMemo(() => {
		const query = draft.trim().toLowerCase();
		if (!query) return CODE_BLOCK_LANGUAGES;
		return CODE_BLOCK_LANGUAGES.filter((language) => {
			if (language.label.toLowerCase().includes(query)) return true;
			if (language.id.toLowerCase().includes(query)) return true;
			return language.aliases?.some((alias) => alias.toLowerCase().includes(query)) ?? false;
		});
	}, [draft]);

	React.useEffect(
		() => () => {
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
		},
		[],
	);

	React.useEffect(() => {
		if (!isEditing) return undefined;
		const timer = setTimeout(() => inputRef.current?.focus(), 0);
		return () => clearTimeout(timer);
	}, [isEditing]);

	const openPicker = React.useCallback(() => {
		setDraft("");
		setActiveIndex(0);
		setKeyboardNavigated(false);
		setIsEditing(true);
	}, []);

	const closePicker = React.useCallback((restoreFocus = false) => {
		setIsEditing(false);
		setDraft("");
		setActiveIndex(0);
		setKeyboardNavigated(false);
		setPopupPosition(null);
		if (restoreFocus) queueMicrotask(() => languageButtonRef.current?.focus());
	}, []);

	const commit = React.useCallback(
		(value = draft) => {
			const next = normalizeLanguage(value);
			updateAttributes({ language: next ?? null });
			closePicker(true);
		},
		[closePicker, draft, updateAttributes],
	);

	const updatePopupPosition = React.useCallback(() => {
		const toolbar = toolbarRef.current;
		if (!toolbar) return;
		const toolbarRect = toolbar.getBoundingClientRect();
		const width = Math.min(POPUP_WIDTH, Math.max(0, window.innerWidth - POPUP_VIEWPORT_INSET * 2));
		const isRtl = getComputedStyle(toolbar).direction === "rtl";
		const preferredLeft = isRtl ? toolbarRect.right - width : toolbarRect.left;
		const left = Math.min(
			Math.max(preferredLeft, POPUP_VIEWPORT_INSET),
			window.innerWidth - POPUP_VIEWPORT_INSET - width,
		);
		const popupHeight = popoverRef.current?.offsetHeight ?? 0;
		const spaceBelow =
			window.innerHeight - toolbarRect.bottom - POPUP_VIEWPORT_INSET - POPUP_OFFSET;
		const spaceAbove = toolbarRect.top - POPUP_VIEWPORT_INSET - POPUP_OFFSET;
		const openAbove = popupHeight > spaceBelow && spaceAbove > spaceBelow;
		const maxHeight = Math.max(0, openAbove ? spaceAbove : spaceBelow);
		const top = openAbove
			? toolbarRect.top - Math.min(popupHeight, maxHeight) - POPUP_OFFSET
			: toolbarRect.bottom + POPUP_OFFSET;
		setPopupPosition((current) => {
			if (
				current?.left === left &&
				current.maxHeight === maxHeight &&
				current.top === top &&
				current.width === width
			) {
				return current;
			}
			return { left, maxHeight, top, width };
		});
	}, []);

	React.useLayoutEffect(() => {
		if (!isEditing) return undefined;
		updatePopupPosition();
		const frame = requestAnimationFrame(updatePopupPosition);
		const resizeObserver =
			typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePopupPosition);
		if (popoverRef.current) resizeObserver?.observe(popoverRef.current);
		window.addEventListener("resize", updatePopupPosition);
		window.addEventListener("scroll", updatePopupPosition, true);
		return () => {
			cancelAnimationFrame(frame);
			resizeObserver?.disconnect();
			window.removeEventListener("resize", updatePopupPosition);
			window.removeEventListener("scroll", updatePopupPosition, true);
		};
	}, [isEditing, updatePopupPosition]);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		switch (e.key) {
			case "ArrowDown":
			case "ArrowUp": {
				if (filteredLanguages.length === 0) return;
				e.preventDefault();
				const direction = e.key === "ArrowDown" ? 1 : -1;
				setKeyboardNavigated(true);
				setActiveIndex(
					(index) => (index + direction + filteredLanguages.length) % filteredLanguages.length,
				);
				break;
			}
			case "Enter": {
				e.preventDefault();
				const activeLanguage = keyboardNavigated ? filteredLanguages[activeIndex] : undefined;
				commit(activeLanguage?.id ?? draft);
				break;
			}
			case "Escape":
				e.preventDefault();
				closePicker(true);
				break;
		}
	};

	React.useEffect(() => {
		if (!keyboardNavigated) return;
		document.getElementById(`${listboxId}-option-${activeIndex}`)?.scrollIntoView({
			block: "nearest",
		});
	}, [activeIndex, keyboardNavigated, listboxId]);

	React.useEffect(() => {
		if (!isEditing) return undefined;
		const onMouseDown = (event: MouseEvent) => {
			const target = event.target instanceof Node ? event.target : null;
			if (
				target &&
				!popoverRef.current?.contains(target) &&
				!toolbarRef.current?.contains(target)
			) {
				closePicker(false);
			}
		};
		document.addEventListener("mousedown", onMouseDown);
		return () => document.removeEventListener("mousedown", onMouseDown);
	}, [isEditing, closePicker]);

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

	const handleToolbarKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
		const buttons = [...(toolbarRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
		if (buttons.length === 0) return;
		event.preventDefault();
		const activeElement = document.activeElement;
		const currentIndex =
			activeElement instanceof HTMLButtonElement ? Math.max(0, buttons.indexOf(activeElement)) : 0;
		const nextIndex =
			event.key === "Home"
				? 0
				: event.key === "End"
					? buttons.length - 1
					: (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) %
						buttons.length;
		buttons[nextIndex]?.focus();
	};

	const label = languageLabel(storedLanguage);
	const currentLanguageId = normalizeLanguage(storedLanguage);
	const controlsPersistent = isEditing || copied;
	const activeOptionId =
		keyboardNavigated && filteredLanguages[activeIndex]
			? `${listboxId}-option-${activeIndex}`
			: undefined;

	return (
		<NodeViewWrapper
			className="emdash-inline-code-block"
			data-language={storedLanguage || undefined}
		>
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div
				className="emdash-inline-code-block-controls-wrap"
				data-persistent={controlsPersistent ? "true" : "false"}
				contentEditable={false}
			>
				<div
					ref={toolbarRef}
					className="emdash-inline-code-block-controls"
					role="toolbar"
					aria-label="Code block actions"
					onKeyDown={handleToolbarKeyDown}
				>
					<button
						ref={languageButtonRef}
						type="button"
						className="emdash-inline-code-block-action emdash-inline-code-block-language-button"
						onMouseDown={(event) => event.preventDefault()}
						onClick={() => (isEditing ? closePicker(true) : openPicker())}
						title="Set language"
						aria-label={`Set language (current: ${label})`}
						aria-haspopup="listbox"
						aria-expanded={isEditing}
						aria-controls={isEditing ? listboxId : undefined}
					>
						<span className="emdash-inline-code-block-language-label">{label}</span>
						<CaretDownIcon />
					</button>
					<button
						type="button"
						tabIndex={-1}
						className="emdash-inline-code-block-action emdash-inline-code-block-copy-button"
						onMouseDown={(event) => event.preventDefault()}
						onClick={copyCode}
						title={copied ? "Copied" : "Copy code"}
						aria-label={copied ? "Copied" : "Copy code"}
					>
						<span
							className="emdash-inline-code-block-copy-success"
							data-copied={copied ? "true" : "false"}
						>
							<CheckIcon />
						</span>
						<span
							className="emdash-inline-code-block-copy-default"
							data-copied={copied ? "true" : "false"}
						>
							<CopyIcon />
						</span>
					</button>
				</div>
				<span className="emdash-inline-code-block-sr-only" role="status" aria-live="polite">
					{copied ? "Copied" : ""}
				</span>
				{isEditing ? (
					<div
						ref={popoverRef}
						className="emdash-inline-code-block-popover"
						style={{
							left: popupPosition?.left ?? 0,
							maxBlockSize: popupPosition
								? `min(16rem, 30vh, ${popupPosition.maxHeight}px)`
								: undefined,
							top: popupPosition?.top ?? 0,
							width: popupPosition?.width ?? 0,
							visibility: popupPosition ? "visible" : "hidden",
						}}
					>
						<input
							ref={inputRef}
							type="text"
							value={draft}
							onChange={(event) => {
								setDraft(event.target.value);
								setActiveIndex(0);
								setKeyboardNavigated(false);
							}}
							onKeyDown={handleKeyDown}
							onBlur={(event) => {
								const nextTarget = event.relatedTarget;
								if (
									nextTarget instanceof Node &&
									(popoverRef.current?.contains(nextTarget) ||
										toolbarRef.current?.contains(nextTarget))
								) {
									return;
								}
								closePicker(false);
							}}
							className="emdash-inline-code-block-language-input"
							placeholder="Search for a language…"
							aria-label="Search for a language"
							role="combobox"
							aria-autocomplete="list"
							aria-expanded="true"
							aria-controls={listboxId}
							aria-activedescendant={activeOptionId}
							autoComplete="off"
							spellCheck={false}
						/>
						<div id={listboxId} className="emdash-inline-code-block-language-list" role="listbox">
							{filteredLanguages.map((language, index) => (
								<div
									key={language.id}
									id={`${listboxId}-option-${index}`}
									className="emdash-inline-code-block-language-option"
									role="option"
									aria-selected={index === activeIndex}
									data-active={index === activeIndex ? "true" : "false"}
									onMouseEnter={() => setActiveIndex(index)}
									onMouseDown={(event) => event.preventDefault()}
									onClick={() => commit(language.id)}
								>
									<span>{language.label}</span>
									{currentLanguageId === language.id ? <CheckIcon /> : null}
								</div>
							))}
							{filteredLanguages.length === 0 ? (
								<div className="emdash-inline-code-block-language-empty" role="status">
									No matches
								</div>
							) : null}
						</div>
					</div>
				) : null}
			</div>
		</NodeViewWrapper>
	);
}

/**
 * Code block extension with inline language picker for the visual editor.
 *
 * Use as a drop-in replacement for StarterKit's default `codeBlock`:
 * configure `StarterKit.configure({ codeBlock: false })` and add this
 * extension to the editor.
 */
export const InlineCodeBlockExtension = CodeBlockLowlight.extend({
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
		return ReactNodeViewRenderer(InlineCodeBlockNodeView);
	},
}).configure({
	lowlight: editorLowlight,
	defaultLanguage: "plaintext",
	enableTabIndentation: true,
	tabSize: 4,
});
