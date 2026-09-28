/**
 * Code block node view for the inline (visual editing) Portable Text editor.
 *
 * Mirrors the admin editor's `CodeBlockNode` but with no Kumo/Lingui deps,
 * so it can ship as part of the SSR runtime. Wraps the Lowlight code block and
 * overlays a small inline language picker in the top-right corner of each code
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
	{ id: "lua", label: "Lua" },
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
	{ id: "zig", label: "Zig" },
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
	textarea.dataset.emdashClipboardFallback = "";
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
function CodeBlockLanguageDatalist({ id }: { id: string }) {
	return (
		<datalist id={id}>
			{CODE_BLOCK_LANGUAGES.map((lang) => (
				<option key={lang.id} value={lang.id} label={lang.label} />
			))}
		</datalist>
	);
}

const iconButtonStyle: React.CSSProperties = {
	height: "1.75rem",
	width: "1.75rem",
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	border: "none",
	background: "transparent",
	cursor: "pointer",
	color: "inherit",
	borderRadius: "0.25rem",
};

function CheckIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<polyline points="20 6 9 17 4 12" />
		</svg>
	);
}

function XIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<line x1="18" y1="6" x2="6" y2="18" />
			<line x1="6" y1="6" x2="18" y2="18" />
		</svg>
	);
}

function InlineCodeBlockNodeView({ node, updateAttributes }: NodeViewProps) {
	const [isEditing, setIsEditing] = React.useState(false);
	const [copyStatus, setCopyStatus] = React.useState<"idle" | "copied" | "failed">("idle");
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [draft, setDraft] = React.useState(storedLanguage);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const popoverRef = React.useRef<HTMLDivElement>(null);
	const copyResetTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
	const copyRequestId = React.useRef(0);
	// Per-instance datalist id so multiple code blocks (or multiple inline
	// editors) on the same page don't create duplicate DOM ids.
	const datalistId = React.useId();

	React.useEffect(() => {
		if (!isEditing) {
			setDraft(storedLanguage);
		}
	}, [storedLanguage, isEditing]);

	const openPicker = React.useCallback(() => {
		setDraft(storedLanguage);
		setIsEditing(true);
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
	React.useEffect(
		() => () => {
			copyRequestId.current += 1;
			if (copyResetTimer.current) clearTimeout(copyResetTimer.current);
		},
		[],
	);
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

	const label = languageLabel(storedLanguage);
	const copied = copyStatus === "copied";
	const copyFailed = copyStatus === "failed";

	return (
		<NodeViewWrapper
			className="emdash-inline-code-block"
			data-language={storedLanguage || undefined}
		>
			<CodeBlockLanguageDatalist id={datalistId} />
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div
				className="emdash-inline-code-block-controls-wrap"
				data-persistent={isEditing || copyStatus !== "idle" ? "true" : "false"}
				contentEditable={false}
			>
				{isEditing ? (
					<div
						ref={popoverRef}
						className="emdash-inline-code-block-popover"
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.25rem",
							padding: "0.25rem",
							borderRadius: "0.375rem",
							boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
						}}
					>
						<input
							ref={inputRef}
							type="text"
							list={datalistId}
							value={draft}
							onChange={(e) => setDraft(e.target.value)}
							onKeyDown={handleKeyDown}
							className="emdash-inline-code-block-language-input"
							placeholder="Language"
							aria-label="Language"
							style={{
								height: "1.75rem",
								fontSize: "0.75rem",
								padding: "0 0.5rem",
								borderRadius: "0.25rem",
							}}
						/>
						<button
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={commit}
							title="Apply language"
							aria-label="Apply language"
							style={iconButtonStyle}
						>
							<CheckIcon />
						</button>
						<button
							type="button"
							onMouseDown={(e) => e.preventDefault()}
							onClick={closePicker}
							title="Cancel"
							aria-label="Cancel"
							style={iconButtonStyle}
						>
							<XIcon />
						</button>
					</div>
				) : (
					<div
						className="emdash-inline-code-block-chip"
						style={{
							display: "inline-flex",
							maxWidth: "min(100%, calc(100vw - 1rem))",
							height: "26px",
							fontSize: "13px",
						}}
					>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={openPicker}
							title="Set language"
							aria-label={`Set language (current: ${label})`}
							style={{
								minWidth: 0,
								flexShrink: 1,
								display: "inline-flex",
								alignItems: "center",
								gap: "0.25rem",
								padding: "0 0.5rem",
								border: 0,
								background: "transparent",
								color: "inherit",
								font: "inherit",
							}}
						>
							<span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
								{storedLanguage ? label : "Set language"}
							</span>
							<span style={{ flexShrink: 0 }} aria-hidden="true">
								⌄
							</span>
						</button>
						<button
							type="button"
							onMouseDown={(event) => event.preventDefault()}
							onClick={copyCode}
							title={copyFailed ? "Retry copy" : copied ? "Copied" : "Copy code"}
							aria-label={copyFailed ? "Retry copy" : "Copy code"}
							style={{
								...iconButtonStyle,
								height: "26px",
								width: "26px",
								flexShrink: 0,
								borderInlineStart: "1px solid var(--emdash-code-border)",
							}}
						>
							<span aria-hidden="true">
								{copied ? <CheckIcon /> : copyFailed ? <XIcon /> : "⧉"}
							</span>
						</button>
					</div>
				)}
				<span
					role="status"
					aria-live="polite"
					style={{
						position: "absolute",
						width: 1,
						height: 1,
						overflow: "hidden",
						clipPath: "inset(50%)",
					}}
				>
					{copyFailed ? "Copy failed" : copied ? "Copied" : ""}
				</span>
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
