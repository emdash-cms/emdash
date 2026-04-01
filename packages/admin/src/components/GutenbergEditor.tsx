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
	WritingFlow,
	ObserveTyping,
} from "@wordpress/block-editor";
import {
	unregisterBlockType,
	getBlockTypes,
	type BlockInstance,
} from "@wordpress/blocks";
// @ts-ignore - @wordpress/block-library does not ship types
import { registerCoreBlocks } from "@wordpress/block-library";
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
			margin: 0;
		}

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
			margin-top: 0;
			margin-bottom: 0;
			max-width: none;
		}

		.gutenberg-editor-wrapper .block-editor-default-block-appender .block-editor-default-block-appender__content {
			color: #94a3b8;
		}

		.gutenberg-editor-wrapper .is-selected > .block-editor-block-list__block-edit::after {
			border-color: #3b82f6;
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

	const handleInput = React.useCallback((newBlocks: BlockInstance[]) => {
		userEditedRef.current = true;
		setBlocks(newBlocks);
	}, []);

	const handleChange = React.useCallback((newBlocks: BlockInstance[]) => {
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
						hasFixedToolbar: true,
						bodyPlaceholder: _placeholder,
						mediaUpload,
					} as Record<string, unknown>}
				>
					<div className="gutenberg-editor-layout flex">
						<div className="gutenberg-editor-content flex-1 min-h-[300px]">
							<WritingFlow>
								<ObserveTyping>
									<BlockList />
								</ObserveTyping>
							</WritingFlow>
						</div>
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
