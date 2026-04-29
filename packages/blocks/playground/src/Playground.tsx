import { BlockRenderer, validateBlocks } from "@emdash-cms/blocks";
import type { Block, BlockInteraction } from "@emdash-cms/blocks";
import { Sun, Moon, Share, Check, Trash, CaretDown, Warning, Plus } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { blockCatalog } from "./block-defaults";
import { templates } from "./templates";
import { useResizable } from "./useResizable";

// ── Types ────────────────────────────────────────────────────────────────────

interface ActionLogEntry {
	id: number;
	timestamp: Date;
	interaction: BlockInteraction;
}

// ── Hash sharing ─────────────────────────────────────────────────────────────

function encodeToHash(blocks: Block[]): string {
	try {
		const json = JSON.stringify(blocks);
		return btoa(encodeURIComponent(json));
	} catch {
		return "";
	}
}

function decodeFromHash(hash: string): Block[] | null {
	try {
		const json = decodeURIComponent(atob(hash));
		const parsed: unknown = JSON.parse(json);
		if (!Array.isArray(parsed)) return null;
		const result = validateBlocks(parsed);
		if (!result.valid) return null;
		return parsed as Block[];
	} catch {
		return null;
	}
}

// ── Drag handle ──────────────────────────────────────────────────────────────

function DragHandle({
	onMouseDown,
	isDragging,
}: {
	onMouseDown: (e: React.MouseEvent) => void;
	isDragging: boolean;
}) {
	return (
		<div
			className={`group relative w-[5px] shrink-0 cursor-col-resize ${isDragging ? "bg-kumo-info/40" : ""}`}
			onMouseDown={onMouseDown}
		>
			{/* Visible border line */}
			<div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-kumo-line group-hover:bg-kumo-info/50" />
		</div>
	);
}

// ── Component ────────────────────────────────────────────────────────────────

export function Playground() {
	const [theme, setTheme] = useState<"light" | "dark">(() => {
		if (
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches
		) {
			return "dark";
		}
		return "light";
	});

	// Load initial blocks from hash or first template
	const [blocks, setBlocks] = useState<Block[]>(() => {
		if (typeof window !== "undefined" && window.location.hash.length > 1) {
			const decoded = decodeFromHash(window.location.hash.slice(1));
			if (decoded) return decoded;
		}
		return templates[0]?.blocks ?? [];
	});

	const [editorText, setEditorText] = useState(() => JSON.stringify(blocks, null, 2));
	const [parseError, setParseError] = useState<string | null>(null);
	const [validationErrors, setValidationErrors] = useState<string[]>([]);
	const [actionLog, setActionLog] = useState<ActionLogEntry[]>([]);
	const [copied, setCopied] = useState(false);
	const [templateMenuOpen, setTemplateMenuOpen] = useState(false);
	const logEndRef = useRef<HTMLDivElement>(null);
	const nextId = useRef(0);
	const templateMenuRef = useRef<HTMLDivElement>(null);

	// Resizable panels
	const catalog = useResizable({ initial: 220, min: 160, max: 320 });
	const editor = useResizable({ initial: 480, min: 300, max: 800 });

	// Apply theme
	useEffect(() => {
		document.documentElement.setAttribute("data-theme", theme);
	}, [theme]);

	// Close template menu on outside click
	useEffect(() => {
		function handleClick(e: MouseEvent) {
			if (templateMenuRef.current && !templateMenuRef.current.contains(e.target as Node)) {
				setTemplateMenuOpen(false);
			}
		}
		if (templateMenuOpen) {
			document.addEventListener("mousedown", handleClick);
			return () => document.removeEventListener("mousedown", handleClick);
		}
	}, [templateMenuOpen]);

	// Auto-scroll log
	useEffect(() => {
		logEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [actionLog]);

	// Parse editor text into blocks
	const updateFromText = useCallback((text: string) => {
		setEditorText(text);
		try {
			const parsed: unknown = JSON.parse(text);
			setParseError(null);
			if (!Array.isArray(parsed)) {
				setParseError("Root must be an array of blocks");
				return;
			}
			const result = validateBlocks(parsed);
			const validated = parsed as Block[];
			if (!result.valid) {
				setValidationErrors(result.errors.map((e) => `${e.path}: ${e.message}`));
				// Still render what we can
				setBlocks(validated);
			} else {
				setValidationErrors([]);
				setBlocks(validated);
			}
		} catch (err) {
			setParseError(err instanceof Error ? err.message : "Invalid JSON");
		}
	}, []);

	// Handle block interactions
	const handleAction = useCallback((interaction: BlockInteraction) => {
		setActionLog((prev) => [...prev, { id: nextId.current++, timestamp: new Date(), interaction }]);
	}, []);

	// Load a template
	const loadTemplate = useCallback((index: number) => {
		const template = templates[index];
		if (!template) return;
		const text = JSON.stringify(template.blocks, null, 2);
		setEditorText(text);
		setBlocks(template.blocks);
		setParseError(null);
		setValidationErrors([]);
		setTemplateMenuOpen(false);
	}, []);

	// Insert a block from the catalog
	const insertBlock = useCallback(
		(catalogIndex: number) => {
			const entry = blockCatalog[catalogIndex];
			if (!entry) return;
			const newBlock = entry.create();
			const updated = [...blocks, newBlock];
			const text = JSON.stringify(updated, null, 2);
			setBlocks(updated);
			setEditorText(text);
			setParseError(null);
			setValidationErrors([]);
		},
		[blocks],
	);

	// Share URL
	const shareUrl = useCallback(async () => {
		const hash = encodeToHash(blocks);
		const url = `${window.location.origin}${window.location.pathname}#${hash}`;
		window.history.replaceState(null, "", `#${hash}`);
		try {
			await navigator.clipboard.writeText(url);
			setCopied(true);
			setTimeout(setCopied, 2000, false);
		} catch {
			// Fallback: just update the URL
		}
	}, [blocks]);

	// Error count for status bar
	const errorCount = useMemo(() => {
		let count = 0;
		if (parseError) count++;
		count += validationErrors.length;
		return count;
	}, [parseError, validationErrors]);

	return (
		<div className="flex h-screen flex-col" style={{ colorScheme: theme }}>
			{/* ── Toolbar ─────────────────────────────────────── */}
			<header className="flex h-11 shrink-0 items-center gap-2 border-b border-kumo-line bg-kumo-bg px-3">
				<span className="text-sm font-semibold text-kumo-text">Block Kit Playground</span>

				<div className="ms-auto flex items-center gap-1.5">
					{/* Template picker */}
					<div className="relative" ref={templateMenuRef}>
						<button
							type="button"
							onClick={() => setTemplateMenuOpen((v) => !v)}
							className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-kumo-text-secondary hover:bg-kumo-tint"
						>
							Templates
							<CaretDown size={12} weight="bold" />
						</button>
						{templateMenuOpen && (
							<div
								className="absolute end-0 top-full z-50 mt-1 w-64 rounded-lg border border-kumo-line p-1 shadow-lg"
								style={{ backgroundColor: "var(--kumo-bg, Canvas)" }}
							>
								{templates.map((t, i) => (
									<button
										key={t.name}
										type="button"
										onClick={() => loadTemplate(i)}
										className="flex w-full flex-col items-start rounded-md px-3 py-2 text-start hover:bg-kumo-tint"
									>
										<span className="text-sm font-medium text-kumo-text">{t.name}</span>
										<span className="text-xs text-kumo-text-secondary">{t.description}</span>
									</button>
								))}
							</div>
						)}
					</div>

					{/* Share */}
					<button
						type="button"
						onClick={shareUrl}
						className="flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-kumo-text-secondary hover:bg-kumo-tint"
					>
						{copied ? <Check size={14} /> : <Share size={14} />}
						{copied ? "Copied!" : "Share"}
					</button>

					{/* Theme toggle */}
					<button
						type="button"
						onClick={() => setTheme((t) => (t === "light" ? "dark" : "light"))}
						className="rounded-md p-1.5 text-kumo-text-secondary hover:bg-kumo-tint"
						aria-label="Toggle theme"
					>
						{theme === "light" ? <Moon size={16} /> : <Sun size={16} />}
					</button>
				</div>
			</header>

			{/* ── Three-column layout ─────────────────────────── */}
			<div className="flex min-h-0 flex-1">
				{/* ── Left: Block catalog ──────────────────────── */}
				<div className="flex shrink-0 flex-col" style={{ width: catalog.width }}>
					<div className="flex h-8 items-center border-b border-kumo-line bg-kumo-tint/50 px-3">
						<span className="text-[11px] font-medium uppercase tracking-wide text-kumo-text-secondary">
							Add Block
						</span>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-1.5">
						{blockCatalog.map((entry, i) => (
							<button
								key={entry.type}
								type="button"
								onClick={() => insertBlock(i)}
								className="flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-start hover:bg-kumo-tint"
							>
								<Plus
									size={14}
									weight="bold"
									className="mt-0.5 shrink-0 text-kumo-text-secondary"
								/>
								<div className="min-w-0">
									<div className="text-xs font-medium text-kumo-text">{entry.label}</div>
									<div className="text-[11px] leading-tight text-kumo-text-secondary">
										{entry.description}
									</div>
								</div>
							</button>
						))}
					</div>
				</div>

				<DragHandle onMouseDown={catalog.handleMouseDown} isDragging={catalog.isDragging} />

				{/* ── Center: JSON editor ──────────────────────── */}
				<div className="flex shrink-0 flex-col" style={{ width: editor.width }}>
					<div className="flex h-8 items-center border-b border-kumo-line bg-kumo-tint/50 px-3">
						<span className="text-[11px] font-medium uppercase tracking-wide text-kumo-text-secondary">
							JSON Editor
						</span>
						{errorCount > 0 && (
							<span className="ms-auto flex items-center gap-1 text-[11px] font-medium text-kumo-warning">
								<Warning size={12} weight="fill" />
								{errorCount} {errorCount === 1 ? "error" : "errors"}
							</span>
						)}
					</div>
					<textarea
						className="editor-textarea min-h-0 flex-1 border-none bg-kumo-bg p-3 text-kumo-text outline-none"
						value={editorText}
						onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => updateFromText(e.target.value)}
						spellCheck={false}
						autoCapitalize="off"
						autoCorrect="off"
					/>
					{/* Error display */}
					{(parseError ?? validationErrors.length > 0) && (
						<div className="max-h-32 shrink-0 overflow-auto border-t border-kumo-line bg-kumo-danger/5 p-2">
							{parseError && <p className="text-xs text-kumo-danger">{parseError}</p>}
							{validationErrors.map((err, i) => (
								<p key={i} className="text-xs text-kumo-warning">
									{err}
								</p>
							))}
						</div>
					)}
				</div>

				<DragHandle onMouseDown={editor.handleMouseDown} isDragging={editor.isDragging} />

				{/* ── Right: Preview + Action log ──────────────── */}
				<div className="flex min-w-0 flex-1 flex-col">
					{/* Preview */}
					<div className="flex h-8 items-center border-b border-kumo-line bg-kumo-tint/50 px-3">
						<span className="text-[11px] font-medium uppercase tracking-wide text-kumo-text-secondary">
							Preview
						</span>
					</div>
					<div className="min-h-0 flex-1 overflow-auto p-4">
						<div className="mx-auto max-w-2xl">
							{!parseError && blocks.length > 0 ? (
								<BlockRenderer blocks={blocks} onAction={handleAction} />
							) : (
								<div className="flex h-full items-center justify-center">
									<p className="text-sm text-kumo-text-secondary">
										{parseError
											? "Fix JSON errors to see preview"
											: "Enter block JSON to see preview"}
									</p>
								</div>
							)}
						</div>
					</div>

					{/* Action log */}
					<div className="flex h-48 shrink-0 flex-col border-t border-kumo-line">
						<div className="flex h-8 items-center border-b border-kumo-line bg-kumo-tint/50 px-3">
							<span className="text-[11px] font-medium uppercase tracking-wide text-kumo-text-secondary">
								Action Log
							</span>
							<span className="ms-1.5 rounded-full bg-kumo-tint px-1.5 py-0.5 text-[10px] font-medium text-kumo-text-secondary">
								{actionLog.length}
							</span>
							{actionLog.length > 0 && (
								<button
									type="button"
									onClick={() => setActionLog([])}
									className="ms-auto rounded-md p-1 text-kumo-text-secondary hover:bg-kumo-tint"
									aria-label="Clear log"
								>
									<Trash size={12} />
								</button>
							)}
						</div>
						<div className="min-h-0 flex-1 overflow-auto p-2">
							{actionLog.length === 0 ? (
								<p className="p-2 text-xs text-kumo-text-secondary">
									Interact with the preview to see actions logged here.
								</p>
							) : (
								actionLog.map((entry) => (
									<div
										key={entry.id}
										className="action-log-entry border-b border-kumo-line/50 px-2 py-1.5 last:border-b-0"
									>
										<div className="flex items-baseline gap-2">
											<span className="shrink-0 text-kumo-text-secondary">
												{entry.timestamp.toLocaleTimeString()}
											</span>
											<span className="rounded bg-kumo-tint px-1 py-0.5 text-[10px] font-semibold uppercase text-kumo-text-secondary">
												{entry.interaction.type}
											</span>
											{"action_id" in entry.interaction && (
												<span className="font-medium text-kumo-text">
													{entry.interaction.action_id}
												</span>
											)}
										</div>
										{"values" in entry.interaction && (
											<pre className="mt-1 text-[11px] text-kumo-text-secondary">
												{JSON.stringify(entry.interaction.values, null, 2)}
											</pre>
										)}
										{"value" in entry.interaction && entry.interaction.value !== undefined && (
											<pre className="mt-1 text-[11px] text-kumo-text-secondary">
												{JSON.stringify(entry.interaction.value)}
											</pre>
										)}
									</div>
								))
							)}
							<div ref={logEndRef} />
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
