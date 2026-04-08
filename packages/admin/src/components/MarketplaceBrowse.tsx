/**
 * Marketplace Browse
 *
 * Grid of plugin cards with search and sorting.
 * Navigates to plugin detail on card click.
 */

import { Badge, Button } from "@cloudflare/kumo";
import {
	MagnifyingGlass,
	PuzzlePiece,
	DownloadSimple,
	ShieldCheck,
	ShieldWarning,
	Warning,
	ArrowsClockwise,
} from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import {
	CAPABILITY_LABELS,
	searchMarketplace,
	type MarketplacePluginSummary,
	type MarketplaceSearchOpts,
} from "../lib/api/marketplace.js";
import { safeIconUrl } from "../lib/url.js";

type SortOption = "installs" | "updated" | "created" | "name";

const SORT_OPTIONS = new Set<string>(["installs", "updated", "created", "name"]);

function isSortOption(value: string): value is SortOption {
	return SORT_OPTIONS.has(value);
}

const SORT_LABELS: Record<SortOption, string> = {
	installs: "Most Popular",
	updated: "Recently Updated",
	created: "Newest",
	name: "Name",
};

export interface MarketplaceBrowseProps {
	/** IDs of plugins already installed on this site */
	installedPluginIds?: Set<string>;
}

export function MarketplaceBrowse({ installedPluginIds = new Set() }: MarketplaceBrowseProps) {
	const [searchQuery, setSearchQuery] = React.useState("");
	const [sort, setSort] = React.useState<SortOption>("installs");
	const [capability, setCapability] = React.useState<string>("");
	const [debouncedQuery, setDebouncedQuery] = React.useState("");

	// Debounce search input
	React.useEffect(() => {
		const timer = setTimeout(setDebouncedQuery, 300, searchQuery);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	const searchOpts: MarketplaceSearchOpts = {
		q: debouncedQuery || undefined,
		capability: capability || undefined,
		sort,
		limit: 20,
	};

	const { data, isLoading, error, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useInfiniteQuery({
			queryKey: ["marketplace", "search", searchOpts],
			queryFn: ({ pageParam }) => searchMarketplace({ ...searchOpts, cursor: pageParam }),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (lastPage) => lastPage.nextCursor,
		});

	const plugins = data?.pages.flatMap((p) => p.items);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-3xl font-bold">Marketplace</h1>
				<p className="mt-1 text-kumo-subtle">Browse and install plugins to extend your site.</p>
			</div>

			{/* Search + Sort */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="relative flex-1">
					<MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kumo-subtle" />
					<input
						type="search"
						placeholder="Search plugins..."
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="w-full rounded-md border bg-kumo-base px-3 py-2 pl-9 text-sm placeholder:text-kumo-subtle focus:outline-none focus:ring-2 focus:ring-kumo-ring"
					/>
				</div>
				<select
					value={capability}
					onChange={(e) => setCapability(e.target.value)}
					className="rounded-md border bg-kumo-base px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-kumo-ring"
					aria-label="Filter by capability"
				>
					<option value="">All capabilities</option>
					{Object.entries(CAPABILITY_LABELS).map(([value, label]) => (
						<option key={value} value={value}>
							{label}
						</option>
					))}
				</select>
				<select
					value={sort}
					onChange={(e) => {
						const v = e.target.value;
						if (isSortOption(v)) setSort(v);
					}}
					className="rounded-md border bg-kumo-base px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-kumo-ring"
					aria-label="Sort plugins"
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
					<h3 className="mt-3 font-medium text-kumo-danger">Unable to reach marketplace</h3>
					<p className="mt-1 text-sm text-kumo-subtle">
						{error instanceof Error ? error.message : "An error occurred"}
					</p>
					<Button variant="ghost" className="mt-4" onClick={() => void refetch()}>
						<ArrowsClockwise className="mr-2 h-4 w-4" />
						Retry
					</Button>
				</div>
			)}

			{/* Loading state */}
			{isLoading && (
				<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 6 }).map((_, i) => (
						<div key={i} className="animate-pulse rounded-lg border bg-kumo-base p-4">
							<div className="flex items-center gap-3">
								<div className="h-10 w-10 rounded-lg bg-kumo-tint" />
								<div className="flex-1 space-y-2">
									<div className="h-4 w-24 rounded bg-kumo-tint" />
									<div className="h-3 w-16 rounded bg-kumo-tint" />
								</div>
							</div>
							<div className="mt-3 space-y-2">
								<div className="h-3 w-full rounded bg-kumo-tint" />
								<div className="h-3 w-2/3 rounded bg-kumo-tint" />
							</div>
						</div>
					))}
				</div>
			)}

			{/* Results grid */}
			{plugins && !isLoading && (
				<>
					{plugins.length === 0 ? (
						<div className="rounded-lg border bg-kumo-base p-8 text-center">
							<PuzzlePiece className="mx-auto h-12 w-12 text-kumo-subtle" />
							<h3 className="mt-4 text-lg font-medium">No plugins found</h3>
							<p className="mt-2 text-sm text-kumo-subtle">
								{debouncedQuery
									? `No results for "${debouncedQuery}". Try a different search term.`
									: "The marketplace is empty. Check back later for new plugins."}
							</p>
						</div>
					) : (
						<>
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
								{plugins.map((plugin) => (
									<PluginCard
										key={plugin.id}
										plugin={plugin}
										isInstalled={installedPluginIds.has(plugin.id)}
									/>
								))}
							</div>
							{hasNextPage && (
								<div className="flex justify-center">
									<Button
										variant="outline"
										onClick={() => void fetchNextPage()}
										disabled={isFetchingNextPage}
									>
										{isFetchingNextPage ? "Loading..." : "Load more"}
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
// PluginCard
// ---------------------------------------------------------------------------

interface PluginCardProps {
	plugin: MarketplacePluginSummary;
	isInstalled: boolean;
}

function PluginCard({ plugin, isInstalled }: PluginCardProps) {
	const navigate = useNavigate();
	const auditVerdict = plugin.latestVersion?.audit?.verdict;
	const imageVerdict = plugin.latestVersion?.imageAudit?.verdict;
	const isImageFlagged = imageVerdict === "warn" || imageVerdict === "fail";
	const iconSrc = plugin.iconUrl ? safeIconUrl(plugin.iconUrl, 64) : null;

	return (
		<Link
			to="/plugins/marketplace/$pluginId"
			params={{ pluginId: plugin.id }}
			className="group block rounded-lg border bg-kumo-base p-4 transition-colors hover:border-kumo-brand/50 hover:bg-kumo-tint/30"
		>
			<div className="flex items-start gap-3">
				{/* Icon */}
				{iconSrc ? (
					<img
						src={iconSrc}
						alt=""
						className={`h-10 w-10 rounded-lg object-cover ${isImageFlagged ? "blur-sm" : ""}`}
						loading="lazy"
						aria-label={isImageFlagged ? "Icon blurred due to image audit" : undefined}
					/>
				) : (
					<PluginAvatar name={plugin.name} />
				)}

				{/* Name + meta */}
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h3 className="truncate font-semibold group-hover:text-kumo-brand">{plugin.name}</h3>
						{isInstalled && (
							<span
								role="link"
								className="cursor-pointer"
								onClick={(e) => {
									e.preventDefault();
									e.stopPropagation();
									void navigate({ to: "/plugins-manager" });
								}}
							>
								<Badge variant="secondary">Installed</Badge>
							</span>
						)}
					</div>
					<div className="flex items-center gap-2 text-xs text-kumo-subtle">
						<span>{plugin.author.name}</span>
						{plugin.author.verified && <ShieldCheck className="h-3 w-3 text-kumo-brand" />}
						{plugin.latestVersion?.version && <span>v{plugin.latestVersion.version}</span>}
					</div>
				</div>
			</div>

			{/* Description */}
			{plugin.description && (
				<p className="mt-2 line-clamp-2 text-sm text-kumo-subtle">{plugin.description}</p>
			)}

			{/* Footer: install count + audit + capabilities */}
			<div className="mt-3 flex items-center justify-between">
				<div className="flex items-center gap-2 text-xs text-kumo-subtle">
					<DownloadSimple className="h-3.5 w-3.5" />
					<span>{formatInstallCount(plugin.installCount)}</span>
				</div>
				<div className="flex items-center gap-1">
					{auditVerdict && <AuditBadge verdict={auditVerdict} />}
					{plugin.capabilities.length > 0 && (
						<span className="text-xs text-kumo-subtle">
							{plugin.capabilities.length} permission{plugin.capabilities.length !== 1 ? "s" : ""}
						</span>
					)}
				</div>
			</div>
		</Link>
	);
}

// ---------------------------------------------------------------------------
// Shared small components
// ---------------------------------------------------------------------------

function PluginAvatar({ name }: { name: string }) {
	const initial = name.charAt(0).toUpperCase();
	return (
		<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-kumo-brand/10 text-kumo-brand font-bold text-lg">
			{initial}
		</div>
	);
}

export function AuditBadge({ verdict }: { verdict: "pass" | "warn" | "fail" }) {
	if (verdict === "pass") {
		return (
			<span
				className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-green-500/10 text-green-600"
				title="Security audit passed"
			>
				<ShieldCheck className="h-3 w-3" />
				Pass
			</span>
		);
	}
	if (verdict === "warn") {
		return (
			<span
				className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-warning/10 text-warning"
				title="Security audit flagged concerns"
			>
				<Warning className="h-3 w-3" />
				Warn
			</span>
		);
	}
	return (
		<span
			className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs bg-kumo-danger/10 text-kumo-danger"
			title="Security audit failed"
		>
			<ShieldWarning className="h-3 w-3" />
			Fail
		</span>
	);
}

function formatInstallCount(count: number): string {
	if (count >= 1000) {
		return `${(count / 1000).toFixed(count >= 10000 ? 0 : 1)}k`;
	}
	return String(count);
}

export default MarketplaceBrowse;
