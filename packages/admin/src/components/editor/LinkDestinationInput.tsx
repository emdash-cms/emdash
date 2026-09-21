/**
 * Combined link destination field for the rich text editor's link controls.
 *
 * One input accepts both URLs and search terms, like WordPress's link
 * control: text that doesn't look like a URL searches entries by title
 * through the admin search endpoint and lists them below the field. Picking
 * an entry turns it into a public URL via `contentUrl`, so the inserted href
 * matches what the entry's "View" link produces. Editors with draft access
 * also find unpublished entries; a draft whose URL pattern needs a publish
 * date cannot be linked until it is published.
 */

import { Input, Loader } from "@cloudflare/kumo";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { apiFetch, fetchContent, fetchManifest, throwResponseError } from "../../lib/api";
import type { ContentItem } from "../../lib/api";
import { useDebouncedValue } from "../../lib/hooks";
import { contentUrl } from "../../lib/url.js";
import { cn } from "../../lib/utils";
import { ContentStatusBadge } from "../ContentStatusBadge.js";

export interface LinkSearchResult {
	collection: string;
	id: string;
	slug: string | null;
	locale: string;
	title?: string;
	status: "published" | "draft";
}

const RESULT_LIMIT = 8;
const MIN_QUERY_LENGTH = 2;
const DATE_TOKEN = /\{(year|month|day|hour|minute|second)\}/;
const SCHEME_OR_PATH = /^([a-z][a-z0-9+.-]*:|[/#?])/i;
const DOMAIN_LIKE = /^\S+\.\S{2,}$/;

/**
 * Anything scheme-like (`https:`, `mailto:`), path-like (`/`, `#`, `?`), or
 * domain-like (`example.com`) is treated as a URL the author is typing, not
 * a search query. Domain-like text is ambiguous -- `vue.js` may be a pasted
 * host or a title -- so only scheme/path input disables search entirely;
 * domain-like input still searches but Enter keeps applying the raw text
 * unless the author explicitly selects a result.
 */
export function looksLikeUrl(value: string): boolean {
	const trimmed = value.trim();
	return SCHEME_OR_PATH.test(trimmed) || DOMAIN_LIKE.test(trimmed);
}

async function searchByStatus(query: string, status?: string): Promise<LinkSearchResult[]> {
	// Title-scoped: body-text matches surprise authors picking a link target.
	const params = new URLSearchParams({ q: query, limit: String(RESULT_LIMIT), scope: "title" });
	if (status) params.set("status", status);
	const response = await apiFetch(`/_emdash/api/search?${params}`);
	if (!response.ok) await throwResponseError(response, i18n._(msg`Search failed`));
	const body = (await response.json()) as { data?: { items?: Omit<LinkSearchResult, "status">[] } };
	return (body.data?.items ?? []).map((item) => ({
		...item,
		status: status === "draft" ? ("draft" as const) : ("published" as const),
	}));
}

/**
 * Search published and draft entries in parallel. The endpoint filters on one
 * status per request and silently downgrades the draft request to published
 * for users without draft access, so the draft bucket is deduplicated against
 * the published one.
 */
export async function searchLinkTargets(query: string): Promise<LinkSearchResult[]> {
	const [published, drafts] = await Promise.all([
		searchByStatus(query),
		searchByStatus(query, "draft"),
	]);
	const seen = new Set(published.map((item) => `${item.collection}:${item.id}`));
	return [...published, ...drafts.filter((item) => !seen.has(`${item.collection}:${item.id}`))];
}

export interface LinkDestinationInputProps {
	/** Current field text (a URL or a search query), controlled by the host. */
	value: string;
	onValueChange: (value: string) => void;
	/** Called when the user presses Enter without a highlighted search result. */
	onSubmit: () => void;
	/** Called with the resolved public URL of the picked entry. */
	onPick: (href: string) => void;
	/** Called when the user presses Escape. */
	onEscape: () => void;
	className?: string;
}

export function LinkDestinationInput({
	value,
	onValueChange,
	onSubmit,
	onPick,
	onEscape,
	className,
}: LinkDestinationInputProps) {
	const { t } = useLingui();
	const debouncedValue = useDebouncedValue(value, 300);
	const [activeIndex, setActiveIndex] = React.useState(-1);
	const [isResolving, setIsResolving] = React.useState(false);
	const listboxId = React.useId();
	const inputRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const { data: manifest } = useQuery({ queryKey: ["manifest"], queryFn: fetchManifest });

	const query = debouncedValue.trim();
	const searchEnabled = query.length >= MIN_QUERY_LENGTH && !SCHEME_OR_PATH.test(query);
	const {
		data: rawResults,
		isFetching,
		isError,
	} = useQuery({
		queryKey: ["link-content-search", query],
		queryFn: () => searchLinkTargets(query),
		enabled: searchEnabled,
	});

	// Entries in non-routable collections have no public URL to link to.
	const results = React.useMemo(
		() =>
			searchEnabled
				? (rawResults ?? []).filter(
						(item) => manifest?.collections[item.collection]?.routable !== false,
					)
				: [],
		[searchEnabled, rawResults, manifest],
	);

	// Pre-highlight the first result so Enter picks it, like WordPress's
	// link control; plain text makes a broken href, so it never wins over
	// a visible result. URL-like text stays unhighlighted: there Enter
	// applies the text itself and results are opt-in via arrow keys/click.
	const preHighlight = !looksLikeUrl(query);
	React.useEffect(() => {
		setActiveIndex(results.length > 0 && preHighlight ? 0 : -1);
	}, [results, preHighlight]);

	const [pickError, setPickError] = React.useState<string | null>(null);
	React.useEffect(() => {
		setPickError(null);
	}, [value]);

	const resolveHref = React.useCallback(
		async (item: LinkSearchResult): Promise<string | null> => {
			const collectionConfig = manifest?.collections[item.collection];
			const urlPattern = collectionConfig?.urlPattern;
			// Date tokens need the entry's publish date, which search results
			// don't carry; fetch the entry only for date-token patterns. Until
			// the entry is published its dated URL isn't final (a draft can
			// still carry an old or scheduled publish date), so anything not
			// currently published has no linkable URL here -- inserting the
			// pattern with literal or stale tokens would bake a broken href
			// into the content.
			if (urlPattern && DATE_TOKEN.test(urlPattern)) {
				let entry: ContentItem;
				try {
					entry = await fetchContent(item.collection, item.id, { locale: item.locale });
				} catch {
					return null;
				}
				const date = entry.publishedAt;
				if (entry.status !== "published" || !date) return null;
				return contentUrl(item.collection, item.slug || item.id, urlPattern, {
					locale: item.locale,
					i18n: manifest?.i18n,
					id: item.id,
					date,
				});
			}
			return contentUrl(item.collection, item.slug || item.id, urlPattern, {
				locale: item.locale,
				i18n: manifest?.i18n,
				id: item.id,
			});
		},
		[manifest],
	);

	const pick = React.useCallback(
		async (item: LinkSearchResult) => {
			setIsResolving(true);
			try {
				const href = await resolveHref(item);
				if (href) {
					onPick(href);
				} else {
					setPickError(t`This entry has no URL until it is published. Paste a URL instead.`);
				}
			} finally {
				setIsResolving(false);
			}
		},
		[onPick, resolveHref, t],
	);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "ArrowDown" && results.length > 0) {
			e.preventDefault();
			setActiveIndex((index) => Math.min(index + 1, results.length - 1));
		} else if (e.key === "ArrowUp" && results.length > 0) {
			e.preventDefault();
			setActiveIndex((index) => Math.max(index - 1, preHighlight ? 0 : -1));
		} else if (e.key === "Enter") {
			e.preventDefault();
			const item = activeIndex >= 0 ? results[activeIndex] : undefined;
			if (item) {
				void pick(item);
			} else {
				onSubmit();
			}
		} else if (e.key === "Escape") {
			e.preventDefault();
			onEscape();
		}
	};

	const showList = results.length > 0;

	return (
		<div className={cn("flex min-w-72 flex-col gap-1", className)}>
			<div className="relative">
				<Input
					ref={inputRef}
					type="text"
					role="combobox"
					aria-expanded={showList}
					aria-controls={listboxId}
					aria-activedescendant={
						showList && activeIndex >= 0 ? `${listboxId}-${activeIndex}` : undefined
					}
					aria-autocomplete="list"
					placeholder={t`Search or type a URL`}
					aria-label={t`Search or type a URL`}
					value={value}
					onChange={(e) => onValueChange(e.target.value)}
					onKeyDown={handleKeyDown}
					className="h-8 w-full text-sm"
					disabled={isResolving}
				/>
				{(isFetching || isResolving) && (
					<span className="absolute inset-e-2 top-1/2 -translate-y-1/2">
						<Loader size="sm" aria-hidden="true" />
					</span>
				)}
			</div>
			<ul
				id={listboxId}
				role="listbox"
				aria-label={t`Content search results`}
				className={cn("max-h-64 overflow-y-auto", !showList && "hidden")}
			>
				{results.map((item, index) => {
					const collectionConfig = manifest?.collections[item.collection];
					return (
						// Selection follows aria-activedescendant while focus stays
						// on the input, so the option itself handles the click; a
						// nested button would add a second, divergent focus stop.
						// oxlint-disable-next-line click-events-have-key-events -- keyboard selection is handled on the combobox input
						<li
							key={`${item.collection}:${item.id}`}
							id={`${listboxId}-${index}`}
							role="option"
							aria-selected={index === activeIndex}
							aria-disabled={isResolving || undefined}
							className={cn(
								"flex cursor-pointer flex-col gap-0.5 rounded-md px-2 py-1.5",
								index === activeIndex ? "bg-kumo-interact/50" : "hover:bg-kumo-interact/30",
							)}
							onMouseEnter={() => setActiveIndex(index)}
							onMouseDown={(e) => e.preventDefault()}
							onClick={() => {
								if (!isResolving) void pick(item);
							}}
						>
							<span className="flex items-center gap-1.5 text-sm text-kumo-default">
								<span className="truncate">{item.title || item.slug || item.id}</span>
								{item.status === "draft" && (
									<ContentStatusBadge state="draft" className="flex-none" />
								)}
							</span>
							<span className="truncate text-xs text-kumo-subtle">
								{collectionConfig?.labelSingular || collectionConfig?.label || item.collection}
							</span>
						</li>
					);
				})}
			</ul>
			{pickError && (
				<p role="alert" className="px-2 py-1 text-xs text-kumo-danger">
					{pickError}
				</p>
			)}
			{searchEnabled && isError && (
				<p role="alert" className="px-2 py-1 text-xs text-kumo-danger">
					{t`Search failed. Check your connection and try again.`}
				</p>
			)}
			{searchEnabled && !isFetching && !isError && results.length === 0 && (
				<p className="px-2 py-1 text-xs text-kumo-subtle">{t`No matching content found.`}</p>
			)}
		</div>
	);
}
