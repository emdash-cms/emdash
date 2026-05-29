import { LexicalEditor, BlockPicker, PropertyPanel } from "@emdash-cms/blocks";
import {
	ArrowLeft,
	Browser,
	CheckCircle,
	Desktop,
	DeviceMobile,
	Eye,
	FloppyDisk,
	SpinnerGap,
	WarningCircle,
} from "@phosphor-icons/react";
/**
 * BuilderEditor — Visual page builder using LexicalEditor.
 *
 * Layout:
 *  ┌─────────────┬───────────────────────────┬───────────────┐
 *  │ BlockPicker │      LexicalEditor        │ PropertyPanel │
 *  │  (left)    │      (center canvas)      │   (right)    │
 *  └─────────────┴───────────────────────────┴───────────────┘
 *
 * BlockPicker and PropertyPanel both consume LexicalEditorContext.
 * Both are used INSIDE LexicalComposer so context is available.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { autosaveContent } from "../../lib/api/content.js";
import { contentUrl } from "../../lib/url.js";

export interface BuilderEditorProps {
	collection?: string;
	id?: string;
	field?: string;
	initialContent?: string;
	slug?: string;
	title?: string;
	status?: string;
	urlPattern?: string;
}

type DeviceMode = "desktop" | "tablet" | "mobile";

const DEVICE_OPTIONS: Array<{
	id: DeviceMode;
	label: string;
	width: number;
	icon: typeof Desktop;
}> = [
	{ id: "desktop", label: "Desktop", width: 1080, icon: Desktop },
	{ id: "tablet", label: "Tablet", width: 768, icon: Browser },
	{ id: "mobile", label: "Mobile", width: 390, icon: DeviceMobile },
];

function getSaveStatusLabel(status: "idle" | "saving" | "saved" | "error") {
	switch (status) {
		case "saving":
			return { label: "Saving", icon: SpinnerGap, className: "text-kumo-subtle" };
		case "saved":
			return { label: "Saved", icon: CheckCircle, className: "text-green-600" };
		case "error":
			return { label: "Save failed", icon: WarningCircle, className: "text-red-600" };
		default:
			return { label: "Draft ready", icon: FloppyDisk, className: "text-kumo-subtle" };
	}
}

function getContentStats(editorContent: string) {
	try {
		const parsed = JSON.parse(editorContent) as {
			root?: {
				children?: Array<{ type?: string; text?: string; children?: Array<{ text?: string }> }>;
			};
		};
		const children = parsed.root?.children ?? [];
		const text = children
			.flatMap(
				(child) => child.children?.map((textNode) => textNode.text ?? "") ?? [child.text ?? ""],
			)
			.join(" ")
			.trim();
		const words = text ? text.split(/\s+/).length : 0;
		return { blocks: children.length, words };
	} catch {
		return { blocks: 0, words: 0 };
	}
}

/**
 * Debounce hook — delays invoking fn until delay ms have passed since last call.
 */
function useDebouncedCallback<T extends (...args: Parameters<T>) => void>(fn: T, delay: number) {
	const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const fnRef = useRef(fn);
	fnRef.current = fn;

	const invoke = useCallback(
		(...args: Parameters<T>) => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
			timeoutRef.current = setTimeout(() => fnRef.current(...args), delay);
		},
		[delay],
	);

	useEffect(() => {
		return () => {
			if (timeoutRef.current) clearTimeout(timeoutRef.current);
		};
	}, []);

	return invoke;
}

export function BuilderEditor({
	collection,
	id,
	field = "content",
	initialContent = "",
	slug,
	title,
	status,
	urlPattern,
}: BuilderEditorProps) {
	const [editorContent, setEditorContent] = useState(initialContent);
	const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
	const [device, setDevice] = useState<DeviceMode>("desktop");
	const lastSavedRef = useRef<string>(initialContent);
	const selectedDevice =
		DEVICE_OPTIONS.find((option) => option.id === device) ?? DEVICE_OPTIONS[0]!;
	const saveStatusMeta = getSaveStatusLabel(saveStatus);
	const SaveStatusIcon = saveStatusMeta.icon;
	const stats = useMemo(() => getContentStats(editorContent), [editorContent]);
	const editHref = collection && id ? `/_emdash/admin/content/${collection}/${id}` : undefined;
	const publicHref =
		collection && (slug || id) ? contentUrl(collection, slug || id!, urlPattern) : undefined;
	const displayTitle = title || slug || id || "Untitled page";

	// Debounced autosave — 1 second after last change
	// Only activates when collection and id are provided (i.e., editing a saved page)
	const debouncedSave = useDebouncedCallback(async (json: string) => {
		if (!collection || !id) return;
		if (json === lastSavedRef.current) return; // no changes since last save
		setSaveStatus("saving");
		try {
			await autosaveContent(collection, id, json, field);
			lastSavedRef.current = json;
			setSaveStatus("saved");
		} catch {
			setSaveStatus("error");
		}
	}, 1000);

	const handleChange = useCallback(
		(json: string) => {
			setEditorContent(json);
			debouncedSave(json);
		},
		[debouncedSave],
	);

	const renderLayout = useCallback(
		(editor: ReactNode) => (
			<div className="builder-shell">
				<style>
					{`
					.builder-shell {
						display: grid;
						grid-template-rows: auto minmax(0, 1fr);
						height: calc(100vh - 56px);
						min-height: 620px;
						background: var(--color-kumo-muted, #f6f7f7);
						color: var(--color-kumo-text, #1d2327);
					}
					.builder-topbar {
						display: flex;
						align-items: center;
						justify-content: space-between;
						gap: 1rem;
						border-bottom: 1px solid var(--color-kumo-line, #dcdcde);
						background: var(--color-kumo-bg, #fff);
						padding: 0.75rem 1rem;
					}
					.builder-title {
						display: flex;
						min-width: 0;
						align-items: center;
						gap: 0.75rem;
					}
					.builder-title-main {
						overflow: hidden;
						text-overflow: ellipsis;
						white-space: nowrap;
						font-size: 0.95rem;
						font-weight: 650;
					}
					.builder-title-meta {
						font-size: 0.75rem;
						color: var(--color-kumo-subtle, #646970);
					}
					.builder-actions,
					.builder-device-switcher {
						display: flex;
						align-items: center;
						gap: 0.5rem;
					}
					.builder-icon-button,
					.builder-link-button {
						display: inline-flex;
						min-height: 2.25rem;
						align-items: center;
						justify-content: center;
						gap: 0.4rem;
						border: 1px solid var(--color-kumo-line, #dcdcde);
						border-radius: 0.375rem;
						background: var(--color-kumo-bg, #fff);
						padding: 0 0.75rem;
						font-size: 0.82rem;
						font-weight: 500;
						color: var(--color-kumo-text, #1d2327);
						text-decoration: none;
					}
					.builder-icon-button {
						width: 2.25rem;
						padding: 0;
					}
					.builder-icon-button:hover,
					.builder-link-button:hover,
					.builder-icon-button[data-active='true'] {
						border-color: var(--color-kumo-brand, #2271b1);
						background: var(--color-kumo-tint, #f0f6fc);
					}
					.builder-body {
						display: grid;
						grid-template-columns: 280px minmax(0, 1fr) 320px;
						min-height: 0;
					}
					.builder-panel {
						min-height: 0;
						overflow: auto;
						background: var(--color-kumo-bg, #fff);
					}
					.builder-panel-left {
						border-right: 1px solid var(--color-kumo-line, #dcdcde);
					}
					.builder-panel-right {
						border-left: 1px solid var(--color-kumo-line, #dcdcde);
					}
					.builder-canvas-area {
						min-width: 0;
						overflow: auto;
						padding: 1.5rem;
					}
					.builder-canvas-header {
						display: flex;
						align-items: center;
						justify-content: space-between;
						max-width: 1080px;
						margin: 0 auto 0.75rem;
						color: var(--color-kumo-subtle, #646970);
						font-size: 0.75rem;
					}
					.builder-canvas-frame {
						width: min(100%, var(--builder-canvas-width));
						min-height: 720px;
						margin: 0 auto 2rem;
						border: 1px solid var(--color-kumo-line, #dcdcde);
						background: #fff;
						box-shadow: 0 18px 48px rgba(0, 0, 0, 0.10);
					}
					.builder-lexical {
						min-height: 720px;
					}
					.builder-lexical .lexical-editor__content {
						min-height: 720px !important;
						padding: 3rem !important;
						font-size: 1rem;
						line-height: 1.75;
					}
					.builder-lexical .lexical-editor__content p {
						margin: 0 0 1rem;
					}
					.builder-document-panel {
						border-bottom: 1px solid var(--color-kumo-line, #dcdcde);
						padding: 1rem;
					}
					.builder-document-panel dl {
						display: grid;
						grid-template-columns: auto 1fr;
						gap: 0.5rem 0.75rem;
						margin: 0.75rem 0 0;
						font-size: 0.8rem;
					}
					.builder-document-panel dt {
						color: var(--color-kumo-subtle, #646970);
					}
					.builder-document-panel dd {
						margin: 0;
						text-align: end;
					}
					@media (max-width: 1100px) {
						.builder-body {
							grid-template-columns: 240px minmax(0, 1fr);
						}
						.builder-panel-right {
							display: none;
						}
					}
				`}
				</style>
				<header className="builder-topbar">
					<div className="builder-title">
						{editHref && (
							<a className="builder-icon-button" href={editHref} aria-label="Back to editor">
								<ArrowLeft size={17} aria-hidden="true" />
							</a>
						)}
						<div className="min-w-0">
							<div className="builder-title-main">{displayTitle}</div>
							<div className="builder-title-meta">
								{collection ?? "content"} / {field}
							</div>
						</div>
					</div>

					<div className="builder-device-switcher" aria-label="Canvas size">
						{DEVICE_OPTIONS.map((option) => {
							const Icon = option.icon;
							return (
								<button
									key={option.id}
									type="button"
									className="builder-icon-button"
									data-active={device === option.id}
									onClick={() => setDevice(option.id)}
									title={option.label}
									aria-label={option.label}
								>
									<Icon size={17} aria-hidden="true" />
								</button>
							);
						})}
					</div>

					<div className="builder-actions">
						<span className={`builder-link-button ${saveStatusMeta.className}`}>
							<SaveStatusIcon
								size={16}
								weight={saveStatus === "saving" ? "regular" : "duotone"}
								aria-hidden="true"
							/>
							{saveStatusMeta.label}
						</span>
						{publicHref && (
							<a className="builder-link-button" href={publicHref} target="_blank" rel="noreferrer">
								<Eye size={16} aria-hidden="true" />
								View
							</a>
						)}
					</div>
				</header>

				<div className="builder-body">
					<aside className="builder-panel builder-panel-left">
						<BlockPicker />
					</aside>

					<main className="builder-canvas-area">
						<div className="builder-canvas-header">
							<span>{selectedDevice.label} canvas</span>
							<span>{selectedDevice.width}px</span>
						</div>
						<div
							className="builder-canvas-frame"
							style={
								{ "--builder-canvas-width": `${selectedDevice.width}px` } as React.CSSProperties
							}
						>
							{editor}
						</div>
					</main>

					<aside className="builder-panel builder-panel-right">
						<div className="builder-document-panel">
							<p className="text-xs font-semibold uppercase tracking-[0.08em] text-kumo-subtle">
								Document
							</p>
							<dl>
								<dt>Status</dt>
								<dd>{status ?? "draft"}</dd>
								<dt>Blocks</dt>
								<dd>{stats.blocks}</dd>
								<dt>Words</dt>
								<dd>{stats.words}</dd>
							</dl>
						</div>
						<PropertyPanel />
					</aside>
				</div>
			</div>
		),
		[
			collection,
			device,
			displayTitle,
			editHref,
			field,
			publicHref,
			saveStatus,
			saveStatusMeta.className,
			saveStatusMeta.label,
			selectedDevice,
			stats.blocks,
			stats.words,
			status,
		],
	);

	return (
		<LexicalEditor
			initialContent={initialContent}
			onChange={handleChange}
			className="builder-lexical"
			renderLayout={renderLayout}
		/>
	);
}

export default BuilderEditor;
