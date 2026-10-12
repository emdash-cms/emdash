/**
 * The inline editor's image picker: a popover that pages through the media
 * library nine images at a time, and through any media providers the site
 * has set up, like the admin's media dialog without uploading. A click, or
 * the arrow keys and Enter, chooses an image.
 */

import {
	FloatingPortal,
	autoUpdate,
	flip,
	offset,
	shift,
	size,
	useFloating,
	type VirtualElement,
} from "@floating-ui/react";
import {
	ArrowSquareOut,
	CaretDoubleLeft,
	CaretDoubleRight,
	CaretLeft,
	CaretRight,
	Check,
	Images,
	MagnifyingGlass,
	WarningCircle,
	type Icon,
} from "@phosphor-icons/react";
import * as React from "react";

import { INTERNAL_MEDIA_PREFIX } from "../media/normalize.js";
import { TOOLBAR_POPUP_ATTR, originStyle, transformOrigin } from "./inline-editor-ui.js";

const API_BASE = "/_emdash/api";
const MEDIA_LIBRARY_PATH = "/_emdash/admin/media";
const PAGE_SIZE = 9;
const COLUMNS = 3;
/**
 * Providers list their images without page numbers, so their first images
 * load at once, as many as the admin's media dialog shows.
 */
const PROVIDER_LIMIT = 50;
const SEARCH_DELAY = 250;
/** The longest search the media API accepts. */
const MAX_SEARCH_LENGTH = 200;
/** Twice a tile's width, so thumbnails stay sharp on high-density screens. */
const THUMBNAIL_WIDTH = 240;

/** The image block attributes for a chosen image. */
export interface ChosenImage {
	src: string;
	alt: string | null;
	mediaId: string;
	provider: string;
	width: number | null;
	height: number | null;
	blurhash: string | null;
	dominantColor: string | null;
}

interface Source {
	id: string;
	name: string;
	canSearch: boolean;
}

interface PickerImage {
	id: string;
	name: string;
	thumbnail: string;
	/** Loaded if the thumbnail can't be. */
	original: string;
	chosen: ChosenImage;
}

interface Listing {
	sourceId: string;
	/** The library page it holds. A provider's images come all at once. */
	page: number;
	images: PickerImage[];
	total: number;
	/** The provider has more images than it sent. */
	more: boolean;
}

const LIBRARY: Source = { id: "local", name: "Library", canSearch: true };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function dimension(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** The `data` of a media API response. */
async function fetchData(url: string, signal: AbortSignal): Promise<Record<string, unknown>> {
	const response = await fetch(url, {
		credentials: "same-origin",
		headers: { "X-EmDash-Request": "1" },
		signal,
	});
	if (!response.ok) throw new Error(`Media request failed with status ${response.status}`);
	const body: unknown = await response.json();
	if (!isRecord(body) || !isRecord(body.data)) throw new Error("Unexpected media response");
	return body.data;
}

/**
 * A small rendition of a library image from Astro's image endpoint, so a
 * page of tiles doesn't load nine originals. Vector images load as they are.
 */
function thumbnailUrl(url: string, mimeType: string): string {
	if (!url.startsWith(INTERNAL_MEDIA_PREFIX) || mimeType === "image/svg+xml") return url;
	const params = new URLSearchParams({
		href: new URL(url, window.location.origin).href,
		w: String(THUMBNAIL_WIDTH),
		f: "webp",
	});
	return `/_image?${params}`;
}

/** Loads the original once if the thumbnail fails, as on a site whose image endpoint refuses it. */
function showOriginal(image: HTMLImageElement, original: string) {
	if (image.dataset.original !== undefined || !original) return;
	image.dataset.original = "";
	image.src = original;
}

function toPickerImage(item: unknown, source: Source): PickerImage | null {
	if (!isRecord(item)) return null;
	const id = text(item.id);
	if (!id) return null;
	const meta = isRecord(item.meta) ? item.meta : {};
	const fromLibrary = source.id === LIBRARY.id;
	const storageKey = text(item.storageKey);
	// A library image is its file; a provider's image comes with a preview of its own.
	const original =
		(fromLibrary
			? (text(item.url) ?? (storageKey && `${INTERNAL_MEDIA_PREFIX}${storageKey}`))
			: text(item.previewUrl)) ?? "";
	return {
		id,
		name: text(item.filename) ?? "",
		thumbnail: fromLibrary ? thumbnailUrl(original, text(item.mimeType) ?? "") : original,
		original,
		chosen: {
			src: original,
			alt: text(item.alt)?.trim() ?? null,
			mediaId: id,
			provider: fromLibrary ? "local" : source.id === "external-url" ? "external" : source.id,
			width: dimension(item.width),
			height: dimension(item.height),
			blurhash: text(item.blurhash) ?? text(meta.blurhash) ?? null,
			dominantColor: text(item.dominantColor) ?? text(meta.dominantColor) ?? null,
		},
	};
}

async function loadListing(
	source: Source,
	query: string,
	page: number,
	signal: AbortSignal,
): Promise<Listing> {
	const fromLibrary = source.id === LIBRARY.id;
	const params = new URLSearchParams({ mimeType: "image/" });
	let url: string;
	if (fromLibrary) {
		params.set("page", String(page));
		params.set("limit", String(PAGE_SIZE));
		if (query) params.set("q", query);
		url = `${API_BASE}/media?${params}`;
	} else {
		params.set("limit", String(PROVIDER_LIMIT));
		if (query) params.set("query", query);
		url = `${API_BASE}/media/providers/${encodeURIComponent(source.id)}?${params}`;
	}
	const data = await fetchData(url, signal);
	const images = (Array.isArray(data.items) ? data.items : []).flatMap(
		(item) => toPickerImage(item, source) ?? [],
	);
	return {
		sourceId: source.id,
		page: fromLibrary ? page : 1,
		images,
		total: fromLibrary && typeof data.totalCount === "number" ? data.totalCount : images.length,
		more: !fromLibrary && text(data.nextCursor) !== undefined,
	};
}

/** The library, then the media providers the site has set up that can list their images. */
function useSources(): Source[] {
	const [sources, setSources] = React.useState<Source[]>([LIBRARY]);
	React.useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const data = await fetchData(`${API_BASE}/media/providers`, controller.signal);
				const providers = (Array.isArray(data.items) ? data.items : []).flatMap(
					(item): Source[] => {
						if (!isRecord(item)) return [];
						const id = text(item.id);
						const capabilities = isRecord(item.capabilities) ? item.capabilities : {};
						if (!id || id === LIBRARY.id || capabilities.browse === false) return [];
						return [{ id, name: text(item.name) ?? id, canSearch: capabilities.search === true }];
					},
				);
				if (!controller.signal.aborted && providers.length > 0) {
					setSources([LIBRARY, ...providers]);
				}
			} catch {
				// Without the list of providers, the library is still there to choose from.
			}
		})();
		return () => controller.abort();
	}, []);
	return sources;
}

/**
 * The images for a source, search, and page. While the next ones load, the
 * last ones from the same source stay, so the grid doesn't flash empty.
 */
function useListing(source: Source, query: string, page: number) {
	const [attempt, setAttempt] = React.useState(0);
	const [result, setResult] = React.useState<{
		key: string;
		listing?: Listing;
		failed?: boolean;
	} | null>(null);
	const fromLibrary = source.id === LIBRARY.id;
	// A provider's images come all at once, so its pages need no request of their own.
	const key = [source.id, query, fromLibrary ? page : 1, attempt].join("\n");
	React.useEffect(() => {
		const controller = new AbortController();
		void (async () => {
			try {
				const listing = await loadListing(source, query, page, controller.signal);
				if (!controller.signal.aborted) setResult({ key, listing });
			} catch {
				if (controller.signal.aborted) return;
				setResult((previous) => ({ key, listing: previous?.listing, failed: true }));
			}
		})();
		return () => controller.abort();
		// `key` stands for everything the request depends on.
	}, [key]);
	return {
		listing: result?.listing?.sourceId === source.id ? result.listing : undefined,
		loading: result?.key !== key,
		failed: result?.key === key && result.failed === true,
		retry: () => setAttempt((count) => count + 1),
	};
}

function useDebouncedValue<T>(value: T, delay: number): T {
	const [debounced, setDebounced] = React.useState(value);
	React.useEffect(() => {
		const timer = setTimeout(setDebounced, delay, value);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return debounced;
}

function PickerMessage({
	icon: MessageIcon,
	title,
	detail,
	children,
}: {
	icon: Icon;
	title: string;
	detail?: string;
	children?: React.ReactNode;
}) {
	return (
		<div className="emdash-inline-ui-picker-message">
			<MessageIcon aria-hidden="true" />
			<strong>{title}</strong>
			{detail && <span>{detail}</span>}
			{children}
		</div>
	);
}

export function InlineMediaPicker({
	uiRoot,
	reference,
	origin,
	gap,
	label,
	current,
	fromToolbar = false,
	onChoose,
	onClose,
}: {
	uiRoot: HTMLElement;
	/** What the picker opens below. */
	reference: VirtualElement;
	/**
	 * Where the picker grows from, when not the middle of `reference`. It's
	 * read on every position update, so it must stay the same function.
	 */
	origin?: () => DOMRect;
	/** The space between the picker and `reference`. */
	gap: number;
	label: string;
	/** The image being replaced, which the grid marks. */
	current?: { provider: string; mediaId: string };
	/** Opened from a selection toolbar, which stays while the picker has focus. */
	fromToolbar?: boolean;
	onChoose: (image: ChosenImage) => void;
	/** Escape closes the picker, and so does focus leaving it for the page. */
	onClose: (reason: "escape" | "blur") => void;
}) {
	const pickerRef = React.useRef<HTMLDivElement | null>(null);
	const searchRef = React.useRef<HTMLInputElement>(null);
	const pageInputRef = React.useRef<HTMLInputElement>(null);
	const pointerOutsideRef = React.useRef(false);
	// The image a pointer pressed, as tiles keep their element when their image changes.
	const pressedRef = React.useRef<string | null>(null);
	const onCloseRef = React.useRef(onClose);
	onCloseRef.current = onClose;
	const gridId = React.useId();

	const sources = useSources();
	const [sourceId, setSourceId] = React.useState(LIBRARY.id);
	const source = sources.find((candidate) => candidate.id === sourceId) ?? LIBRARY;
	const fromLibrary = source.id === LIBRARY.id;

	const [search, setSearch] = React.useState("");
	const typedSearch = search.trim().slice(0, MAX_SEARCH_LENGTH);
	const settledSearch = useDebouncedValue(typedSearch, SEARCH_DELAY);
	const query = source.canSearch ? settledSearch : "";

	// Another source or search starts again from the first page.
	const view = `${source.id}\n${query}`;
	const [paging, setPaging] = React.useState({ view, page: 1 });
	const requestedPage = paging.view === view ? paging.page : 1;
	const { listing, loading, failed, retry } = useListing(source, query, requestedPage);
	// Images uploaded in the admin's media library, opened in another tab, show up on coming back.
	const retryRef = React.useRef(retry);
	retryRef.current = retry;
	React.useEffect(() => {
		const refresh = () => {
			if (document.visibilityState === "visible") retryRef.current();
		};
		document.addEventListener("visibilitychange", refresh);
		return () => document.removeEventListener("visibilitychange", refresh);
	}, []);
	const total = listing?.total ?? 0;
	const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
	const page = Math.min(requestedPage, pages);
	const shownPage = fromLibrary ? (listing?.page ?? page) : page;
	const images = !listing
		? []
		: fromLibrary
			? listing.images
			: listing.images.slice((shownPage - 1) * PAGE_SIZE, shownPage * PAGE_SIZE);
	const first = (shownPage - 1) * PAGE_SIZE;
	// The images shown are about to change, so the grid can't be entered yet.
	const updating = loading || (source.canSearch && typedSearch !== settledSearch);

	// A page past the end, as when images have left the library, gives way to the last one.
	React.useEffect(() => {
		if (fromLibrary && listing && !loading && listing.page > pages) {
			setPaging({ view, page: pages });
		}
	}, [fromLibrary, listing, loading, pages, view]);

	const gridView = `${view}\n${shownPage}`;
	const [highlighted, setHighlighted] = React.useState({ view: gridView, index: -1 });
	const highlight =
		highlighted.view === gridView && highlighted.index < images.length ? highlighted.index : -1;
	const setHighlight = (index: number) => setHighlighted({ view: gridView, index });

	const [pageDraft, setPageDraft] = React.useState<string | null>(null);

	const { refs, floatingStyles, middlewareData, isPositioned } = useFloating({
		open: true,
		placement: "bottom-start",
		strategy: "fixed",
		transform: false,
		middleware: [
			offset(gap),
			flip({ padding: 8 }),
			shift({ padding: 8 }),
			size({
				padding: 8,
				apply: ({ availableHeight, elements }) => {
					elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
				},
			}),
			transformOrigin(origin),
		],
		whileElementsMounted: autoUpdate,
	});
	React.useLayoutEffect(() => refs.setPositionReference(reference), [reference, refs]);

	// Focus moves in once the picker is in place, as a hidden field can't take it.
	const focusedRef = React.useRef(false);
	React.useEffect(() => {
		if (!isPositioned || focusedRef.current) return;
		focusedRef.current = true;
		(searchRef.current ?? pickerRef.current)?.focus({ preventScroll: true });
	}, [isPositioned]);

	React.useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const picker = pickerRef.current;
			const outside = !(event.target instanceof Node && picker?.contains(event.target));
			pointerOutsideRef.current = outside;
			// With focus in the picker, the blur that follows closes it, once the toolbars have seen focus go.
			if (outside && !picker?.contains(document.activeElement)) onCloseRef.current("blur");
		};
		// iOS keeps focus in a field when a tap lands where nothing takes focus, so
		// the tap's end lets it go, which closes the picker as a blur would.
		const onPointerUp = () => {
			const activeElement = document.activeElement;
			if (
				pointerOutsideRef.current &&
				activeElement instanceof HTMLElement &&
				pickerRef.current?.contains(activeElement)
			) {
				activeElement.blur();
			}
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		document.addEventListener("pointerup", onPointerUp, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
			document.removeEventListener("pointerup", onPointerUp, true);
		};
	}, []);

	const onBlur = (event: React.FocusEvent<HTMLDivElement>) => {
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		if (next instanceof Node || pointerOutsideRef.current) {
			onClose("blur");
			return;
		}
		// Focus that went nowhere left for another window, which gives it back,
		// went into a frame on the page, or went with a control that left the page.
		if (!document.hasFocus()) return;
		queueMicrotask(() => {
			const picker = pickerRef.current;
			const activeElement = document.activeElement;
			if (!picker?.isConnected || picker.contains(activeElement)) return;
			if (activeElement && activeElement !== document.body) onCloseRef.current("blur");
			else (searchRef.current ?? picker).focus({ preventScroll: true });
		});
	};

	const focusTile = (index: number) => {
		setHighlight(index);
		pickerRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.focus();
	};

	const goTo = (target: number) => {
		setPageDraft(null);
		const next = Math.min(Math.max(1, Math.round(target)), pages);
		if (!Number.isFinite(next) || next === page) return;
		// A tile may not be on the next page, and the buttons at an end turn
		// off there, so focus on either moves to the page number.
		const active = document.activeElement;
		if (
			active instanceof HTMLElement &&
			(active.dataset.index !== undefined ||
				(active.tagName === "BUTTON" &&
					active.closest(".emdash-inline-ui-pagination") &&
					(next === 1 || next === pages)))
		) {
			pageInputRef.current?.focus();
		}
		setPaging({ view, page: next });
	};

	const selectSource = (next: Source, tab: HTMLElement) => {
		if (next.id === source.id) return;
		// The search field stays for a source that can search; otherwise focus goes with the tab.
		if (!(next.canSearch && document.activeElement === searchRef.current)) tab.focus();
		setSourceId(next.id);
	};

	const tryAgain = () => {
		// The button goes once the images load.
		(searchRef.current ?? pickerRef.current)?.focus({ preventScroll: true });
		retry();
	};

	const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.key === "Escape") {
			event.preventDefault();
			onClose("escape");
			return;
		}
		if (event.key === "Tab") {
			// Tab goes around the picker, which Escape leaves.
			const stops = [
				...event.currentTarget.querySelectorAll<HTMLElement>("input, button, a[href]"),
			].filter((element) => element.tabIndex >= 0 && !element.matches(":disabled"));
			if (stops.length === 0) return;
			const index = stops.findIndex((element) => element === document.activeElement);
			const next = event.shiftKey
				? index <= 0
					? stops.length - 1
					: index - 1
				: (index + 1) % stops.length;
			event.preventDefault();
			stops[next]?.focus();
			return;
		}
		const target = event.target;
		if (target === searchRef.current) {
			if (event.key === "ArrowDown" && images.length > 0 && !updating) {
				event.preventDefault();
				focusTile(0);
			}
			return;
		}
		// The tabs and the page controls keep their own keys.
		if (!(target instanceof HTMLElement) || target.dataset.index === undefined) return;
		const index = Number(target.dataset.index);
		const last = images.length - 1;
		const forward = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
		let next: number;
		switch (event.key) {
			case "ArrowDown":
				next = index + COLUMNS;
				// The row below may be short; its last image is the closest.
				if (next > last)
					next = Math.floor(index / COLUMNS) < Math.floor(last / COLUMNS) ? last : index;
				break;
			case "ArrowUp":
				next = index - COLUMNS;
				break;
			case "ArrowRight":
				next = Math.min(last, Math.max(0, index + forward));
				break;
			case "ArrowLeft":
				next = Math.min(last, Math.max(0, index - forward));
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = last;
				break;
			default:
				return;
		}
		event.preventDefault();
		if (next >= 0) {
			focusTile(next);
		} else if (searchRef.current) {
			setHighlight(-1);
			searchRef.current.focus();
		}
	};

	const onTabsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
		const forward = getComputedStyle(event.currentTarget).direction === "rtl" ? -1 : 1;
		const index = sources.findIndex((candidate) => candidate.id === source.id);
		let next: number;
		switch (event.key) {
			case "ArrowRight":
				next = index + forward;
				break;
			case "ArrowLeft":
				next = index - forward;
				break;
			case "Home":
				next = 0;
				break;
			case "End":
				next = sources.length - 1;
				break;
			default:
				return;
		}
		event.preventDefault();
		next = (next + sources.length) % sources.length;
		const tab = event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')[next];
		const nextSource = sources[next];
		if (tab && nextSource) {
			selectSource(nextSource, tab);
			tab.focus();
		}
	};

	const showing = `Showing ${first + 1}–${first + images.length} of ${total}${listing?.more ? "+" : ""}`;
	const waiting = !listing || (images.length === 0 && total > 0);
	const showsGrid = !failed && !waiting && total > 0;
	let announcement: string;
	let body: React.ReactNode;
	if (failed) {
		announcement = "Images couldn't load";
		body = (
			<PickerMessage icon={WarningCircle} title={announcement}>
				<button type="button" className="emdash-inline-ui-picker-action" onClick={tryAgain}>
					Try again
				</button>
			</PickerMessage>
		);
	} else if (waiting) {
		announcement = "Loading images";
		body = (
			<div aria-hidden="true" className="emdash-inline-ui-picker-grid">
				{Array.from({ length: PAGE_SIZE }, (_, index) => (
					<span key={index} className="emdash-inline-ui-picker-tile" />
				))}
			</div>
		);
	} else if (total === 0 && query) {
		announcement = `No images match “${query}”`;
		body = <PickerMessage icon={MagnifyingGlass} title={announcement} detail="Try another name." />;
	} else if (total === 0) {
		announcement = "No images yet";
		body = fromLibrary ? (
			<PickerMessage
				icon={Images}
				title={announcement}
				detail="Images added to the media library show up here."
			>
				<a
					href={MEDIA_LIBRARY_PATH}
					target="_blank"
					rel="noopener noreferrer"
					className="emdash-inline-ui-picker-action"
				>
					Open media library
					<ArrowSquareOut aria-hidden="true" />
					<span className="emdash-inline-ui-sr-only"> (opens in a new tab)</span>
				</a>
			</PickerMessage>
		) : (
			<PickerMessage
				icon={Images}
				title={announcement}
				detail={`Images added to ${source.name} show up here.`}
			/>
		);
	} else {
		announcement = showing;
		body = (
			<div
				id={gridId}
				role="listbox"
				aria-label="Images"
				aria-busy={loading || undefined}
				className="emdash-inline-ui-picker-grid"
			>
				{images.map((image, index) => {
					const name = image.name || "Image";
					const isCurrent =
						current?.mediaId === image.id && current.provider === image.chosen.provider;
					return (
						<button
							// Tiles keep their element from page to page, so one with focus keeps it.
							key={index}
							type="button"
							role="option"
							aria-selected={index === highlight}
							aria-label={isCurrent ? `${name} (current image)` : name}
							tabIndex={index === Math.max(highlight, 0) ? 0 : -1}
							data-index={index}
							data-highlighted={index === highlight ? "" : undefined}
							className="emdash-inline-ui-picker-tile"
							onPointerMove={() => {
								if (index !== highlight) setHighlight(index);
							}}
							onFocus={() => {
								if (index !== highlight) setHighlight(index);
							}}
							onPointerDown={() => {
								pressedRef.current = image.id;
							}}
							onClick={(event) => {
								const pressed = pressedRef.current;
								pressedRef.current = null;
								// A pointer chooses the image it pressed, though new results may have replaced it since.
								if (event.detail > 0 && pressed !== null && pressed !== image.id) return;
								onChoose(image.chosen);
							}}
						>
							{image.thumbnail && (
								<img
									key={image.id}
									src={image.thumbnail}
									alt=""
									loading="lazy"
									decoding="async"
									draggable={false}
									onError={(event) => showOriginal(event.currentTarget, image.original)}
								/>
							)}
							{isCurrent && (
								<span className="emdash-inline-ui-picker-badge">
									<Check weight="bold" aria-hidden="true" />
								</span>
							)}
						</button>
					);
				})}
				{/* A short last page keeps the grid's height, so the page buttons stay under the pointer. */}
				{pages > 1 &&
					Array.from({ length: PAGE_SIZE - images.length }, (_, index) => (
						<span
							key={`filler-${index}`}
							aria-hidden="true"
							className="emdash-inline-ui-picker-filler"
						/>
					))}
			</div>
		);
	}

	return (
		<FloatingPortal root={uiRoot}>
			<div
				ref={(node) => {
					pickerRef.current = node;
					refs.setFloating(node);
				}}
				role="dialog"
				aria-label={label}
				tabIndex={-1}
				className="emdash-inline-ui-picker"
				style={{
					...floatingStyles,
					...originStyle(middlewareData.transformOrigin),
					visibility: isPositioned ? undefined : "hidden",
				}}
				{...(fromToolbar ? { [TOOLBAR_POPUP_ATTR]: "" } : {})}
				onKeyDown={onKeyDown}
				onMouseDown={(event) => {
					// A click leaves focus where it was, so the picker keeps it. Fields still take it.
					if (!(event.target instanceof HTMLInputElement)) event.preventDefault();
				}}
				onBlur={onBlur}
			>
				<span className="emdash-inline-ui-sr-only" role="status">
					{announcement}
				</span>
				{source.canSearch && (
					<div className="emdash-inline-ui-picker-head">
						<label className="emdash-inline-ui-picker-search">
							<MagnifyingGlass aria-hidden="true" />
							<input
								ref={searchRef}
								type="search"
								className="emdash-inline-ui-input"
								value={search}
								placeholder="Search images"
								aria-label="Search images"
								autoComplete="off"
								spellCheck={false}
								onChange={(event) => setSearch(event.target.value)}
							/>
						</label>
					</div>
				)}
				{sources.length > 1 && (
					<div
						role="tablist"
						aria-label="Image source"
						className="emdash-inline-ui-picker-tabs"
						onKeyDown={onTabsKeyDown}
					>
						{sources.map((candidate) => (
							<button
								key={candidate.id}
								type="button"
								role="tab"
								aria-selected={candidate.id === source.id}
								aria-controls={showsGrid ? gridId : undefined}
								tabIndex={candidate.id === source.id ? 0 : -1}
								className="emdash-inline-ui-picker-tab"
								onClick={(event) => selectSource(candidate, event.currentTarget)}
							>
								{candidate.name}
							</button>
						))}
					</div>
				)}
				{body}
				{showsGrid && (
					<div className="emdash-inline-ui-picker-foot">
						<span className="emdash-inline-ui-picker-count" aria-hidden="true">
							{showing}
						</span>
						<nav className="emdash-inline-ui-pagination" aria-label="Image pages">
							<button
								type="button"
								aria-label="First page"
								disabled={page <= 1}
								onClick={() => goTo(1)}
							>
								<CaretDoubleLeft aria-hidden="true" />
							</button>
							<button
								type="button"
								aria-label="Previous page"
								disabled={page <= 1}
								onClick={() => goTo(page - 1)}
							>
								<CaretLeft aria-hidden="true" />
							</button>
							<input
								ref={pageInputRef}
								aria-label="Page number"
								inputMode="numeric"
								autoComplete="off"
								value={pageDraft ?? String(page)}
								onChange={(event) => setPageDraft(event.target.value)}
								onKeyDown={(event) => {
									if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
									event.preventDefault();
									if (pageDraft !== null) goTo(Number(pageDraft));
								}}
								onBlur={() => {
									if (pageDraft !== null) goTo(Number(pageDraft));
								}}
							/>
							<button
								type="button"
								aria-label="Next page"
								disabled={page >= pages}
								onClick={() => goTo(page + 1)}
							>
								<CaretRight aria-hidden="true" />
							</button>
							<button
								type="button"
								aria-label="Last page"
								disabled={page >= pages}
								onClick={() => goTo(pages)}
							>
								<CaretDoubleRight aria-hidden="true" />
							</button>
						</nav>
					</div>
				)}
			</div>
		</FloatingPortal>
	);
}

/** The picker's look, from the admin's media dialog and Kumo's pagination. */
export const INLINE_MEDIA_PICKER_STYLES = `
	.emdash-inline-ui-picker {
		display: flex;
		width: 360px;
		max-width: calc(100vw - 16px);
		flex-direction: column;
		overflow: hidden;
		border-radius: 10px;
		background: var(--emdash-ui-surface);
		box-shadow: 0 0 0 1px var(--emdash-ui-line), var(--emdash-ui-shadow);
		outline: none;
		animation: emdash-inline-ui-menu-in 100ms cubic-bezier(0, 0, 0.2, 1);
	}
	.emdash-inline-ui-picker-head,
	.emdash-inline-ui-picker-tabs {
		display: flex;
		flex: none;
		padding: 4px;
		border-block-end: 1px solid var(--emdash-ui-hairline);
	}
	.emdash-inline-ui-picker-search {
		position: relative;
		min-width: 0;
		flex: 1;
	}
	.emdash-inline-ui-picker-search > svg {
		position: absolute;
		inset-block-start: 50%;
		inset-inline-start: 10px;
		width: 16px;
		height: 16px;
		color: var(--emdash-ui-subtle);
		pointer-events: none;
		translate: 0 -50%;
	}
	.emdash-inline-ui-picker-search > .emdash-inline-ui-input {
		width: 100%;
		padding-inline-start: 34px;
		background: transparent;
		box-shadow: none;
		appearance: none;
	}
	.emdash-inline-ui-picker-tabs {
		gap: 2px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.emdash-inline-ui-picker-tab {
		flex: none;
		height: 28px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--emdash-ui-subtle);
		cursor: pointer;
		font-size: 13px;
		outline: none;
	}
	.emdash-inline-ui-picker-tab:hover {
		color: var(--emdash-ui-text);
	}
	.emdash-inline-ui-picker-tab[aria-selected="true"] {
		background: var(--emdash-ui-tint);
		color: var(--emdash-ui-text);
		font-weight: 500;
	}
	.emdash-inline-ui-picker-tab:focus-visible {
		box-shadow: 0 0 0 2px var(--emdash-ui-brand);
	}
	/* Rows keep their tiles' height and the grid scrolls, rather than squeezing them. */
	.emdash-inline-ui-picker-grid {
		display: grid;
		min-height: 0;
		flex: 0 1 auto;
		grid-template-columns: repeat(${COLUMNS}, minmax(0, 1fr));
		grid-auto-rows: max-content;
		gap: 4px;
		padding: 4px;
		overflow-y: auto;
		overscroll-behavior: contain;
		scroll-padding-block: 4px;
	}
	.emdash-inline-ui-picker-tile {
		position: relative;
		aspect-ratio: 1;
		padding: 0;
		overflow: hidden;
		border: 0;
		border-radius: 6px;
		background: var(--emdash-ui-tint);
		cursor: pointer;
		outline: none;
	}
	.emdash-inline-ui-picker-tile img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.emdash-inline-ui-picker-tile::after {
		content: "";
		position: absolute;
		inset: 0;
		border-radius: inherit;
		box-shadow: inset 0 0 0 1px light-dark(rgb(0 0 0 / 0.06), rgb(255 255 255 / 0.07));
		pointer-events: none;
	}
	.emdash-inline-ui-picker-tile[data-highlighted]::after {
		box-shadow: inset 0 0 0 2px var(--emdash-ui-brand), inset 0 0 0 4px var(--emdash-ui-surface);
	}
	.emdash-inline-ui-picker-filler {
		aspect-ratio: 1;
		visibility: hidden;
	}
	.emdash-inline-ui-picker-badge {
		position: absolute;
		inset-block-start: 6px;
		inset-inline-end: 6px;
		display: grid;
		width: 20px;
		height: 20px;
		place-items: center;
		border-radius: 999px;
		background: var(--emdash-ui-brand);
		box-shadow: 0 0 0 2px var(--emdash-ui-surface);
		color: #fff;
	}
	.emdash-inline-ui-picker-badge svg {
		width: 12px;
		height: 12px;
	}
	.emdash-inline-ui-picker-message {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		padding: 28px 16px;
		color: var(--emdash-ui-subtle);
		text-align: center;
	}
	.emdash-inline-ui-picker-message > svg {
		width: 28px;
		height: 28px;
		margin-block-end: 6px;
	}
	.emdash-inline-ui-picker-message strong {
		max-width: 100%;
		color: var(--emdash-ui-text);
		font-weight: 500;
		overflow-wrap: anywhere;
	}
	.emdash-inline-ui-picker-action {
		display: inline-flex;
		height: 32px;
		align-items: center;
		gap: 6px;
		margin-block-start: 12px;
		padding: 0 10px;
		border: 0;
		border-radius: 6px;
		background: transparent;
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
		color: var(--emdash-ui-text);
		cursor: pointer;
		outline: none;
	}
	.emdash-inline-ui-picker-action:hover {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-picker-action:focus-visible {
		box-shadow: 0 0 0 2px var(--emdash-ui-brand);
	}
	.emdash-inline-ui-picker-action > svg {
		width: 14px;
		height: 14px;
		color: var(--emdash-ui-subtle);
	}
	.emdash-inline-ui-picker-foot {
		display: flex;
		flex: none;
		align-items: center;
		gap: 12px;
		padding-block: 6px;
		padding-inline: 12px 6px;
		border-block-start: 1px solid var(--emdash-ui-hairline);
		color: var(--emdash-ui-subtle);
		font-size: 12px;
		line-height: 16px;
	}
	.emdash-inline-ui-picker-count {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		font-variant-numeric: tabular-nums;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.emdash-inline-ui-pagination {
		display: flex;
		flex: none;
		overflow: hidden;
		border-radius: 8px;
		box-shadow: 0 0 0 1px var(--emdash-ui-line);
	}
	.emdash-inline-ui-pagination > button,
	.emdash-inline-ui-pagination > input {
		width: 28px;
		height: 28px;
		padding: 0;
		border: 0;
		background: var(--emdash-ui-surface);
		color: var(--emdash-ui-text);
		outline: none;
	}
	.emdash-inline-ui-pagination > :not(:first-child) {
		border-inline-start: 1px solid var(--emdash-ui-line);
	}
	.emdash-inline-ui-pagination > button {
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.emdash-inline-ui-pagination > button:hover:not(:disabled) {
		background: var(--emdash-ui-tint);
	}
	.emdash-inline-ui-pagination > button:disabled {
		color: var(--emdash-ui-placeholder);
		cursor: default;
	}
	.emdash-inline-ui-pagination > :focus-visible {
		box-shadow: inset 0 0 0 2px var(--emdash-ui-brand);
	}
	.emdash-inline-ui-pagination svg {
		width: 14px;
		height: 14px;
	}
	.emdash-inline-ui-pagination:dir(rtl) svg {
		scale: -1 1;
	}
	.emdash-inline-ui-pagination > input {
		width: 36px;
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		text-align: center;
	}
	@media (pointer: coarse) {
		.emdash-inline-ui-pagination > button,
		.emdash-inline-ui-pagination > input {
			width: 40px;
			height: 40px;
		}
		/* iOS zooms the page into a field with smaller text. */
		.emdash-inline-ui-pagination > input {
			font-size: 16px;
		}
		.emdash-inline-ui-picker-tab,
		.emdash-inline-ui-picker-action {
			height: 44px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.emdash-inline-ui-picker {
			animation: none;
		}
	}
`;
