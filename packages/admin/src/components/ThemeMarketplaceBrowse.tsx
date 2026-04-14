/**
 * Theme Marketplace Browse
 *
 * Visual-first grid of theme cards with large thumbnails.
 * Navigates to theme detail on card click.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	MagnifyingGlass,
	Palette,
	Warning,
	ArrowsClockwise,
	ArrowSquareOut,
	Eye,
	ShieldCheck,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	searchThemes,
	generatePreviewUrl,
	type ThemeSummary,
	type ThemeSearchOpts,
} from "../lib/api/theme-marketplace.js";

type SortOption = "updated" | "created" | "name";

const SORT_LABELS: Record<SortOption, string> = {
	updated: "Recently Updated",
	created: "Newest",
	name: "Name",
};

const VALID_SORTS = new Set<string>(["updated", "created", "name"]);

function isSortOption(value: string): value is SortOption {
	return VALID_SORTS.has(value);
}

export function ThemeMarketplaceBrowse() {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [sort, setSort] = React.useState<SortOption>("updated");
	const [debouncedQuery, setDebouncedQuery] = React.useState("");

	React.useEffect(() => {
		const timer = setTimeout(setDebouncedQuery, 300, searchQuery);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	const searchOpts: ThemeSearchOpts = {
		q: debouncedQuery || undefined,
		sort,
		limit: 12,
	};

	const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useInfiniteQuery({
			queryKey: ["themes", "search", searchOpts],
			queryFn: ({ pageParam }) => searchThemes({ ...searchOpts, cursor: pageParam }),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (lastPage) => lastPage.nextCursor,
		});

	const themes = data?.pages.flatMap((p) => p.items);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-3xl font-bold">{t`Themes`}</h1>
				<p className="mt-1 text-kumo-subtle">
					{t`Browse themes and preview them with your own content.`}
				</p>
			</div>

			{/* Search + Sort */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="relative flex-1">
					<MagnifyingGlass className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kumo-subtle" />
					<input
						type="search"
						placeholder={t`Search themes...`}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full rounded-md border bg-kumo-base px-3 py-2 ps-9 text-sm placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-ring"
					/>
				</div>
				<select
					value={sort}
					onChange={(e) => {
						const v = e.target.value;
						if (isSortOption(v)) setSort(v);
					}}
					className="rounded-md border bg-kumo-base px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-kumo-ring"
					aria-label={t`Sort themes`}
				>
					{Object.entries(SORT_LABELS).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
			</div>

			{/* Error state */}
			{error && (
				<div className="rounded-lg border border-kumo-danger/50 bg-kumo-danger/10 p-6 text-center">
					<Warning className="mx-auto h-8 w-8 text-kumo-danger" />
					<h3 className="mt-3 font-medium text-kumo-danger">{t`Unable to reach marketplace`}</h3>
					<p className="mt-1 text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : t`An error occurred`}
					</p>
					<Button variant="ghost" className="mt-4" onClick={() => void refetch()}>
						<ArrowsClockwise className="mr-2 h-4 w-4" />
						{t`Retry`}
					</Button>
				</div>
			)}

			{/* Loading state — skeleton cards with thumbnail aspect ratio */}
			{isLoading && (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="animate-pulse rounded-lg border bg-kumo-base overflow-hidden">
							<div className="aspect-video bg-kumo-tint" />
							<div className="p-4 space-y-2">
								<div className="h-4 w-32 rounded bg-kumo-tint" />
								<div className="h-3 w-48 rounded bg-kumo-tint" />
								<div className="h-3 w-20 rounded bg-kumo-tint" />
							</div>
						</div>
					))}
				</div>
			)}

			{/* Results grid */}
			{themes && !isLoading && (
				<>
					{themes.length === 0 ? (
						<div className="rounded-lg border bg-kumo-base p-8 text-center">
							<Palette className="mx-auto h-12 w-12 text-kumo-subtle" />
							<h3 className="mt-4 text-lg font-medium">{t`No themes found`}</h3>
							<p className="mt-2 text-sm text-kumo-subtle">
								{debouncedQuery
									? t`No results for "${debouncedQuery}". Try a different search term.`
									: t`The theme marketplace is empty. Check back later.`}
							</p>
						</div>
					) : (
						<>
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
								{themes.map((theme) => (
									<ThemeCard key={theme.id} theme={theme} />
								))}
							</div>
							{hasNextPage && (
								<div className="flex justify-center">
									<Button
										variant="outline"
										onClick={() => void fetchNextPage()}
										disabled={isFetchingNextPage}
									>
										{isFetchingNextPage ? t`Loading...` : t`Load more`}
									</Button>
								</div>
							)}
						</>
					)}
				</>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// ThemeCard
// ---------------------------------------------------------------------------

function ThemeCard({ theme }: { theme: ThemeSummary }) {
	const { t } = useLingui();
	const thumbnailUrl = theme.thumbnailUrl
		? `/_emdash/api/admin/themes/marketplace/${encodeURIComponent(theme.id)}/thumbnail`
		: null;

	const previewMutation = useMutation({
		mutationFn: () => generatePreviewUrl(theme.previewUrl),
		onSuccess: (url) => {
			window.open(url, "_blank", "noopener");
		},
	});

	return (
		<div className="group rounded-lg border bg-kumo-base overflow-hidden transition-colors hover:border-kumo-brand/50">
			{/* Thumbnail */}
			<Link
				to={"/themes/marketplace/$themeId" as "/"}
				params={{ themeId: theme.id }}
				className="block"
			>
				{thumbnailUrl ? (
					<img
						src={thumbnailUrl}
						alt={t`${theme.name} preview`}
						className="aspect-video w-full object-cover bg-kumo-tint"
						loading="lazy"
					/>
				) : (
					<div className="aspect-video w-full bg-kumo-tint flex items-center justify-center">
						<Palette className="h-12 w-12 text-kumo-subtle/40" />
					</div>
				)}
			</Link>

			{/* Info */}
			<div className="p-4">
				<Link
					to={"/themes/marketplace/$themeId" as "/"}
					params={{ themeId: theme.id }}
					className="block"
				>
					<h3 className="font-semibold group-hover:text-kumo-brand truncate">{theme.name}</h3>
				</Link>

				<div className="flex items-center gap-2 mt-1 text-xs text-kumo-subtle">
					<span>{theme.author.name}</span>
					{theme.author.verified && <ShieldCheck className="h-3 w-3 text-kumo-brand" />}
				</div>

				{theme.description && (
					<p className="mt-2 text-sm text-kumo-subtle line-clamp-2">{theme.description}</p>
				)}

				{/* Action buttons */}
				<div className="mt-3 flex items-center gap-2">
					<Button
						variant="primary"
						size="sm"
						onClick={(e) => {
							e.preventDefault();
							previewMutation.mutate();
						}}
						disabled={previewMutation.isPending}
					>
						<Eye className="mr-1.5 h-3.5 w-3.5" />
						{previewMutation.isPending ? t`Loading...` : t`Try with my data`}
					</Button>

					{theme.demoUrl && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => window.open(theme.demoUrl!, "_blank", "noopener")}
						>
							<ArrowSquareOut className="mr-1.5 h-3.5 w-3.5" />
							{t`Demo`}
						</Button>
					)}
				</div>

				{previewMutation.error && (
					<p className="mt-2 text-xs text-kumo-danger">
						{previewMutation.error instanceof Error
							? previewMutation.error.message
							: t`Failed to generate preview`}
					</p>
				)}
			</div>
		</div>
	);
}

export default ThemeMarketplaceBrowse;
