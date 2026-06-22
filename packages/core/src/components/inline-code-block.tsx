/**
 * Code block node view for the inline (visual editing) Portable Text editor.
 *
 * Mirrors the admin editor's `CodeBlockNode` but with no Kumo/Lingui deps,
 * so it can ship as part of the SSR runtime. Wraps the base
 * `@tiptap/extension-code-block` and overlays a small inline language picker
 * in the top-right corner of each code block.
 *
 * Keep the language list in sync with
 * `packages/admin/src/components/editor/codeBlockLanguages.ts`. Duplicated
 * here so packages/core stays independent of the admin package.
 */

import CodeBlock from "@tiptap/extension-code-block";
import type { NodeViewProps } from "@tiptap/react";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer } from "@tiptap/react";
import * as React from "react";

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

function InlineCodeBlockNodeView({ node, updateAttributes, selected }: NodeViewProps) {
	const [isEditing, setIsEditing] = React.useState(false);
	const [isHovered, setIsHovered] = React.useState(false);
	const storedLanguage = typeof node.attrs.language === "string" ? node.attrs.language : "";
	const [draft, setDraft] = React.useState(storedLanguage);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const popoverRef = React.useRef<HTMLDivElement>(null);
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

	const label = languageLabel(storedLanguage);
	const chipVisible = isHovered || selected || isEditing || Boolean(storedLanguage);

	return (
		<NodeViewWrapper
			className="emdash-inline-code-block"
			data-language={storedLanguage || undefined}
			style={{ position: "relative", margin: "1rem 0" }}
			onMouseEnter={() => setIsHovered(true)}
			onMouseLeave={() => setIsHovered(false)}
		>
			<CodeBlockLanguageDatalist id={datalistId} />
			<pre className="emdash-code-block">
				<NodeViewContent<"code"> as="code" />
			</pre>

			<div
				contentEditable={false}
				style={{
					position: "absolute",
					top: "0.5rem",
					insetInlineEnd: "0.5rem",
					userSelect: "none",
					zIndex: 1,
					opacity: chipVisible ? 1 : 0,
					pointerEvents: chipVisible ? "auto" : "none",
					transition: "opacity 0.15s",
				}}
				// When the chip is hidden, also remove it from the tab order so
				// keyboard users don't land on an invisible focus target.
				// `inert` would be cleaner but isn't available on JSX HTMLDivElement
				// types yet; aria-hidden + tabIndex on the button below cover the
				// same need.
				aria-hidden={chipVisible ? undefined : true}
			>
				{isEditing ? (
					<div
						ref={popoverRef}
						style={{
							display: "flex",
							alignItems: "center",
							gap: "0.25rem",
							padding: "0.25rem",
							borderRadius: "0.375rem",
							border: "1px solid rgba(0,0,0,0.1)",
							background: "var(--emdash-inline-bg, #ffffff)",
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
							placeholder="Language"
							aria-label="Language"
							style={{
								height: "1.75rem",
								width: "10rem",
								fontSize: "0.75rem",
								padding: "0 0.5rem",
								border: "1px solid rgba(0,0,0,0.15)",
								borderRadius: "0.25rem",
								background: "transparent",
								color: "inherit",
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
					<button
						type="button"
						tabIndex={chipVisible ? 0 : -1}
						onMouseDown={(e) => e.preventDefault()}
						onClick={openPicker}
						title="Set language"
						aria-label={`Set language (current: ${label})`}
						className="emdash-inline-code-block-chip"
						style={{
							padding: "0.125rem 0.5rem",
							fontSize: "0.75rem",
							borderRadius: "0.375rem",
							border: "1px solid rgba(0,0,0,0.1)",
							background: "rgba(255,255,255,0.9)",
							color: "rgba(0,0,0,0.6)",
							cursor: "pointer",
						}}
					>
						{storedLanguage ? label : "Set language"}
					</button>
				)}
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
export const InlineCodeBlockExtension = CodeBlock.extend({
	addNodeView() {
		return ReactNodeViewRenderer(InlineCodeBlockNodeView);
	},
});
