/**
 * Registry Browse
 *
 * Grid of plugin cards backed by the experimental decentralized plugin
 * registry's aggregator. Search box debounces directly into the
 * aggregator's `searchPackages` XRPC -- the aggregator is a public,
 * read-only service, so no server proxy is involved.
 *
 * Cards navigate to `/plugins/marketplace/$pluginId` (the same path the
 * marketplace browse uses); the router branches to the registry detail
 * component when `manifest.registry` is configured.
 */

import { Badge, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass, PuzzlePiece, ShieldCheck } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	searchRegistryPackages,
	type RegistryClientConfig,
	type RegistryPackageView,
} from "../lib/api/registry.js";
import { PublisherHandle, usePublisherHandle } from "./PublisherHandle.js";

export interface RegistryBrowseProps {
	/** Resolved manifest.registry block. Required -- caller checks. */
	config: RegistryClientConfig;
	/**
	 * Plugin IDs already installed on this site (derived hashes for
	 * registry installs, see `makeRegistryPluginId`). The UI uses this
	 * only to show an "Installed" badge on browse cards; install gating
	 * happens server-side.
	 */
	installedRegistryUris?: Set<string>;
}

export function RegistryBrowse({ config, installedRegistryUris = new Set() }: RegistryBrowseProps) {
	const { t } = useLingui();
	const [searchQuery, setSearchQuery] = React.useState("");
	const [debouncedQuery, setDebouncedQuery] = React.useState("");

	// Debounce search input
	React.useEffect(() => {
		const timer = setTimeout(setDebouncedQuery, 300, searchQuery);
		return () => clearTimeout(timer);
	}, [searchQuery]);

	const { data, isLoading, error, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useInfiniteQuery({
			queryKey: ["registry", "search", config.aggregatorUrl, debouncedQuery],
			queryFn: ({ pageParam }) =>
				searchRegistryPackages(config, {
					q: debouncedQuery || undefined,
					cursor: pageParam,
					limit: 20,
				}),
			initialPageParam: undefined as string | undefined,
			getNextPageParam: (lastPage) => lastPage.cursor,
		});

	const packages = data?.pages.flatMap((p) => p.packages);

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-3xl font-bold">{t`Plugin Registry`}</h1>
				<p className="mt-1 text-kumo-subtle">{t`Browse and install plugins published to the decentralized registry.`}</p>
			</div>

			{/* Search */}
			<div className="flex flex-col gap-3 sm:flex-row sm:items-center">
				<div className="relative flex-1">
					<MagnifyingGlass className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-kumo-subtle" />
					<Input
						type="search"
						placeholder={t`Search plugins...`}
						value={searchQuery}
						onChange={(e) => setSearchQuery(e.target.value)}
						className="ps-9"
						aria-label={t`Search plugins`}
					/>
				</div>
			</div>

			{/* Error */}
			{error ? (
				<div
					className="rounded-md border border-kumo-error bg-kumo-error/10 p-4 text-kumo-error"
					role="alert"
				>
					{t`Failed to load plugins. The registry aggregator may be unreachable.`}
				</div>
			) : null}

			{/* Loading skeleton */}
			{isLoading ? (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{Array.from({ length: 6 }).map((_, i) => (
						<div
							// eslint-disable-next-line react/no-array-index-key -- skeleton placeholder
							key={i}
							className="h-32 animate-pulse rounded-md border border-kumo-border bg-kumo-subtle"
						/>
					))}
				</div>
			) : null}

			{/* Empty */}
			{packages && packages.length === 0 ? (
				<div className="rounded-md border border-kumo-border bg-kumo-subtle p-8 text-center text-kumo-subtle">
					{debouncedQuery
						? t`No plugins match "${debouncedQuery}".`
						: t`No plugins have been published to this registry yet.`}
				</div>
			) : null}

			{/* Grid */}
			{packages && packages.length > 0 ? (
				<div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
					{packages.map((pkg) => (
						<RegistryPackageCard
							key={pkg.uri}
							pkg={pkg}
							installed={installedRegistryUris.has(pkg.uri)}
						/>
					))}
				</div>
			) : null}

			{/* Load more */}
			{hasNextPage ? (
				<div className="flex justify-center">
					<button
						type="button"
						className="rounded-md border border-kumo-border bg-kumo-surface px-4 py-2 text-sm hover:bg-kumo-subtle disabled:opacity-50"
						onClick={() => fetchNextPage()}
						disabled={isFetchingNextPage}
					>
						{isFetchingNextPage ? t`Loading...` : t`Load more`}
					</button>
				</div>
			) : null}
		</div>
	);
}

interface RegistryPackageCardProps {
	pkg: RegistryPackageView;
	installed: boolean;
}

function RegistryPackageCard({ pkg, installed }: RegistryPackageCardProps) {
	const { t } = useLingui();
	const handleResult = usePublisherHandle(pkg.did, pkg.handle);
	// Always link by handle when we have one (cleaner URL), DID
	// otherwise. The detail page accepts either.
	const linkSegment = handleResult.handle ?? pkg.did;
	// `profile` is a pass-through of the signed package profile record.
	// We duck-type minimal display fields out of it.
	const profile = pkg.profile as { name?: string; description?: string };
	const verified = (pkg.labels ?? []).some((l: { val?: string }) => l.val === "verified");

	return (
		<Link
			to="/plugins/marketplace/$pluginId"
			params={{ pluginId: `${linkSegment}/${pkg.slug}` }}
			className="block rounded-md border border-kumo-border bg-kumo-surface p-4 transition-colors hover:bg-kumo-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
		>
			<div className="flex items-start gap-3">
				<div className="mt-1 rounded-md bg-kumo-subtle p-2 text-kumo-subtle">
					<PuzzlePiece className="h-5 w-5" />
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2">
						<h2 className="truncate font-semibold">{profile.name ?? pkg.slug}</h2>
						{verified ? (
							<ShieldCheck
								className="h-4 w-4 shrink-0 text-kumo-brand"
								aria-label={t`Verified publisher`}
							/>
						) : null}
					</div>
					<PublisherHandle did={pkg.did} aggregatorHandle={pkg.handle} variant="card" />

					{profile.description ? (
						<p className="mt-2 line-clamp-2 text-sm text-kumo-default">{profile.description}</p>
					) : null}
					{installed ? (
						<div className="mt-3">
							<Badge variant="success">{t`Installed`}</Badge>
						</div>
					) : null}
				</div>
			</div>
		</Link>
	);
}
