/**
 * Gutenberg Block Editor Integration
 *
 * Wraps the WordPress Gutenberg block editor (@wordpress/block-editor) to work
 * within EmDash's admin UI. Content is stored as Portable Text internally, and
 * this component handles the conversion to/from Gutenberg's block format.
 */

import {
	BlockEditorProvider,
	BlockList,
	BlockInspector,
	// @ts-ignore - BlockTools is exported but not in the type definitions
	BlockTools,
	WritingFlow,
} from "@wordpress/block-editor";
import {
	unregisterBlockType,
	getBlockTypes,
	type BlockInstance,
} from "@wordpress/blocks";
// @ts-ignore - @wordpress/block-library does not ship types
import { registerCoreBlocks } from "@wordpress/block-library";
// @ts-ignore - registers Bold, Italic, Link, etc. format types
import "@wordpress/format-library";
import { SlotFillProvider, Popover } from "@wordpress/components";
import * as React from "react";

import { uploadMedia } from "../lib/api";
import { cn } from "../lib/utils";
import {
	portableTextToGutenberg,
	gutenbergToPortableText,
	type PortableTextBlock,
} from "./editor/gutenberg-portable-text";

// Track initialization state
let gutenbergInitialized = false;

// Allowed core block types for content editing
const ALLOWED_BLOCKS = [
	"core/paragraph",
	"core/heading",
	"core/list",
	"core/list-item",
	"core/quote",
	"core/image",
	"core/code",
	"core/separator",
	"core/spacer",
	"core/columns",
	"core/column",
	"core/group",
	"core/preformatted",
	"core/pullquote",
	"core/table",
	"core/html",
	"core/freeform",
];

/**
 * Inject custom CSS overrides for the Gutenberg editor within EmDash.
 * The base WordPress stylesheets are imported via admin.astro.
 */
function injectCustomStyles() {
	if (typeof document === "undefined") return;
	if (document.getElementById("gutenberg-emdash-overrides")) return;

	const style = document.createElement("style");
	style.id = "gutenberg-emdash-overrides";
	style.textContent = `
		.gutenberg-editor-wrapper {
			font-family: inherit;
			line-height: 1.6;
			position: relative;
		}

		.gutenberg-editor-wrapper .block-editor-writing-flow {
			padding: 16px;
			min-height: 200px;
		}

		.gutenberg-editor-wrapper .block-editor-block-list__layout {
			padding: 0;
		}

		.gutenberg-editor-wrapper .components-popover {
			z-index: 100;
		}

		.gutenberg-editor-wrapper .block-editor-default-block-appender {
			margin: 0;
		}

		.gutenberg-editor-wrapper .block-editor-block-list__block {
			margin: 0.5em 0 !important;
		}

		.gutenberg-editor-wrapper h1.wp-block { font-size: 2.5em; font-weight: 700; }
		.gutenberg-editor-wrapper h2.wp-block { font-size: 2em; font-weight: 700; }
		.gutenberg-editor-wrapper h3.wp-block { font-size: 1.75em; font-weight: 600; }
		.gutenberg-editor-wrapper h4.wp-block { font-size: 1.5em; font-weight: 600; }
		.gutenberg-editor-wrapper h5.wp-block { font-size: 1.25em; font-weight: 600; }
		.gutenberg-editor-wrapper h6.wp-block { font-size: 1.1em; font-weight: 600; }
		.gutenberg-editor-wrapper [data-type="core/heading"] { margin-top: 0.5em; margin-bottom: 0.25em; }
		.gutenberg-editor-wrapper .rich-text[aria-level="1"] { font-size: 2.5em; font-weight: 700; }
		.gutenberg-editor-wrapper .rich-text[aria-level="2"] { font-size: 2em; font-weight: 700; }
		.gutenberg-editor-wrapper .rich-text[aria-level="3"] { font-size: 1.75em; font-weight: 600; }
		.gutenberg-editor-wrapper .rich-text[aria-level="4"] { font-size: 1.5em; font-weight: 600; }
		.gutenberg-editor-wrapper .rich-text[aria-level="5"] { font-size: 1.25em; font-weight: 600; }
		.gutenberg-editor-wrapper .rich-text[aria-level="6"] { font-size: 1.1em; font-weight: 600; }

		.gutenberg-editor-wrapper .block-editor-block-toolbar {
			border: 1px solid #e2e8f0;
			border-radius: 6px;
			background: white;
		}

		.gutenberg-editor-sidebar {
			font-size: 13px;
		}

		.gutenberg-editor-wrapper .block-editor-inserter__toggle {
			background: transparent;
			border: 1px dashed #cbd5e1;
			border-radius: 4px;
			padding: 4px;
			cursor: pointer;
		}

		.gutenberg-editor-wrapper .block-editor-inserter__toggle:hover {
			border-color: #94a3b8;
			background: #f8fafc;
		}

		.gutenberg-editor-wrapper .block-editor-block-list__block.wp-block {
			max-width: none;
		}

		.gutenberg-editor-wrapper .block-editor-default-block-appender .block-editor-default-block-appender__content {
			color: #94a3b8;
		}

		.gutenberg-editor-wrapper .is-selected > .block-editor-block-list__block-edit::after {
			border-color: #3b82f6;
		}

		/* Block toolbar popover */
		.gutenberg-editor-wrapper .block-editor-block-contextual-toolbar {
			border: 1px solid #e2e8f0;
			border-radius: 6px;
			background: white;
			box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
		}

		/* Between-block inserter */
		.gutenberg-editor-wrapper .block-editor-block-list__insertion-point {
			z-index: 6;
		}

		.gutenberg-editor-wrapper .block-editor-block-list__insertion-point-inserter {
			display: flex;
			align-items: center;
			justify-content: center;
		}

		/* Block movers / drag handle */
		.gutenberg-editor-wrapper .block-editor-block-mover {
			display: flex;
		}

		/* Ensure the BlockTools container doesn't clip popovers */
		.gutenberg-editor-wrapper .block-editor-block-tools {
			position: relative;
		}

		/* Layout support: flex (Row/Stack blocks) */
		.gutenberg-editor-wrapper .is-layout-flex {
			display: flex;
			flex-wrap: wrap;
			align-items: center;
			gap: 0.5em;
		}

		.gutenberg-editor-wrapper .is-layout-flex > * {
			flex-shrink: 1;
			min-width: 0;
		}

		.gutenberg-editor-wrapper .is-layout-flex.is-vertical {
			flex-direction: column;
		}

		.gutenberg-editor-wrapper .is-layout-flex:not(.is-vertical) {
			flex-direction: row;
		}

		/* Columns block */
		.gutenberg-editor-wrapper .wp-block-columns {
			display: flex;
			gap: 1em;
		}

		.gutenberg-editor-wrapper .wp-block-column {
			flex: 1;
			min-width: 0;
		}

		/* Images inside flex/columns should respect container */
		.gutenberg-editor-wrapper .is-layout-flex .wp-block-image,
		.gutenberg-editor-wrapper .wp-block-columns .wp-block-image {
			flex: 1;
			min-width: 0;
		}

		.gutenberg-editor-wrapper .is-layout-flex .wp-block-image img,
		.gutenberg-editor-wrapper .wp-block-columns .wp-block-image img {
			max-width: 100%;
			height: auto;
		}
	`;
	document.head.appendChild(style);
}

function initializeGutenberg() {
	if (gutenbergInitialized) return;

	injectCustomStyles();

	try {
		registerCoreBlocks();
	} catch {
		// Core blocks may already be registered
	}

	// Unregister blocks that don't make sense outside WordPress
	try {
		const allBlocks = getBlockTypes();
		for (const block of allBlocks) {
			if (!ALLOWED_BLOCKS.includes(block.name)) {
				try {
					unregisterBlockType(block.name);
				} catch {
					// Block may not be registered
				}
			}
		}
	} catch {
		// Block types may not be available yet
	}

	gutenbergInitialized = true;
}

export interface GutenbergEditorProps {
	value?: PortableTextBlock[];
	onChange?: (value: PortableTextBlock[]) => void;
	placeholder?: string;
	className?: string;
	editable?: boolean;
	"aria-labelledby"?: string;
	minimal?: boolean;
}

export function GutenbergEditor({
	value,
	onChange,
	placeholder: _placeholder = "Start writing...",
	className,
	editable = true,
	"aria-labelledby": ariaLabelledby,
	minimal = false,
}: GutenbergEditorProps) {
	const contentRef = React.useRef<HTMLDivElement>(null);
	const onChangeRef = React.useRef(onChange);
	React.useEffect(() => {
		onChangeRef.current = onChange;
	}, [onChange]);

	const [initialized, setInitialized] = React.useState(() => {
		initializeGutenberg();
		return true;
	});
	// Fallback if the synchronous init above didn't run (SSR guard)
	React.useEffect(() => {
		if (!initialized) {
			initializeGutenberg();
			setInitialized(true);
		}
	}, [initialized]);

	// Media upload handler for Gutenberg's image/file blocks.
	// This bridges Gutenberg's mediaUpload API to EmDash's media upload endpoint.
	const mediaUpload = React.useCallback(
		({
			filesList,
			onFileChange,
			onError,
		}: {
			filesList: File[];
			onFileChange: (media: Array<Record<string, unknown>>) => void;
			onError: (message: string) => void;
		}) => {
			const uploads = Array.from(filesList).map(async (file) => {
				try {
					const item = await uploadMedia(file);
					return {
						id: item.id,
						url: item.url,
						alt: item.alt || item.filename,
						caption: "",
						width: item.width,
						height: item.height,
						mime: item.mimeType,
						// Preserve original dimensions for resize detection
						emdashOriginalWidth: item.width,
						emdashOriginalHeight: item.height,
					};
				} catch (err) {
					onError(err instanceof Error ? err.message : "Upload failed");
					return null;
				}
			});

			void Promise.all(uploads).then((results) => {
				const uploaded = results.filter(Boolean) as Array<Record<string, unknown>>;
				if (uploaded.length > 0) {
					onFileChange(uploaded);
				}
			});
		},
		[],
	);

	// Convert Portable Text to Gutenberg blocks on mount
	const [blocks, setBlocks] = React.useState<BlockInstance[]>(() => {
		if (!value || value.length === 0) return [];
		try {
			return portableTextToGutenberg(value);
		} catch {
			return [];
		}
	});

	// Track whether the user has made edits (to avoid overwriting with stale prop)
	const userEditedRef = React.useRef(false);

	// Re-sync blocks when value changes from outside (e.g. async data load).
	// Skip if the user has already been editing to avoid clobbering their work.
	const valueFingerprintRef = React.useRef(JSON.stringify(value));
	React.useEffect(() => {
		const newFingerprint = JSON.stringify(value);
		if (newFingerprint === valueFingerprintRef.current) return;
		valueFingerprintRef.current = newFingerprint;

		if (userEditedRef.current) return;
		if (!value || value.length === 0) return;

		try {
			setBlocks(portableTextToGutenberg(value));
		} catch {
			// Conversion failed — keep current blocks
		}
	}, [value]);

	const propagateChange = React.useCallback((newBlocks: BlockInstance[]) => {
		userEditedRef.current = true;
		setBlocks(newBlocks);
		const cb = onChangeRef.current;
		if (cb) {
			try {
				const portableText = gutenbergToPortableText(newBlocks);
				cb(portableText);
			} catch (err) {
				console.error("[GutenbergEditor] Failed to convert blocks to Portable Text:", err);
			}
		}
	}, []);

	// Gutenberg calls onInput for transient changes (typing, resizing) and
	// onChange for persistent changes (block add/remove, attribute commit).
	// Both must propagate to the parent so the form detects dirty state.
	const handleInput = propagateChange;
	const handleChange = propagateChange;

	if (!initialized) {
		return (
			<div className={cn("border rounded-lg", className)}>
				<div className="p-4 text-kumo-subtle">Loading editor...</div>
			</div>
		);
	}

	return (
		<div
			className={cn(
				"gutenberg-editor-wrapper border rounded-lg overflow-hidden",
				minimal && "border-0 rounded-none -mx-4",
				className,
			)}
			aria-labelledby={ariaLabelledby}
		>
			<SlotFillProvider>
				<BlockEditorProvider
					value={blocks}
					onInput={handleInput}
					onChange={handleChange}
					settings={{
						hasFixedToolbar: false,
						bodyPlaceholder: _placeholder,
						mediaUpload,
						__unstableIsPreviewMode: false,
						// Enable layout support (flex/flow/grid) for blocks
						supportsLayout: true,
					} as Record<string, unknown>}
				>
					<div className="gutenberg-editor-layout flex">
						<BlockTools
							__unstableContentRef={contentRef}
							className="gutenberg-editor-content flex-1 min-h-[300px]"
							style={{ position: "relative" }}
						>
							<WritingFlow
								ref={contentRef}
								className="editor-styles-wrapper"
								style={{ padding: 16, minHeight: 200 }}
							>
								<BlockList />
							</WritingFlow>
						</BlockTools>
						{!minimal && editable && (
							<div className="gutenberg-editor-sidebar w-[280px] border-l bg-kumo-tint/30 p-4 overflow-y-auto max-h-[600px]">
								<BlockInspector />
							</div>
						)}
					</div>
					<Popover.Slot />
				</BlockEditorProvider>
			</SlotFillProvider>
		</div>
	);
}

export default GutenbergEditor;
