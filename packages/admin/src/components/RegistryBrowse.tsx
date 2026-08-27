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

import { Badge, Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	searchRegistryPackages,
	registryQueryPolicyKey,
	type RegistryClientConfig,
	type RegistryPackageView,
} from "../lib/api/registry.js";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { PublisherIdentity } from "./PublisherHandle.js";

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

	const {
		data: cachedData,
		isLoading,
		isFetchedAfterMount,
		error,
		fetchNextPage,
		hasNextPage,
		isFetchingNextPage,
	} = useInfiniteQuery({
		queryKey: [
			"registry",
			"search",
			config.aggregatorUrl,
			registryQueryPolicyKey(config),
			debouncedQuery,
		],
		queryFn: ({ pageParam }) =>
			searchRegistryPackages(config, {
				q: debouncedQuery || undefined,
				cursor: pageParam,
				limit: 20,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.cursor,
		refetchOnMount: "always",
		refetchOnWindowFocus: "always",
		refetchInterval: 30_000,
	});

	const data = isFetchedAfterMount && !error ? cachedData : undefined;
	const packages = data?.pages.flatMap((p) => p.packages);
	const isSafetyRefreshPending = isLoading || !isFetchedAfterMount;

	return (
		<div className="space-y-6">
			{/* Header */}
			<div>
				<h1 className="text-2xl font-semibold leading-tight">{t`Plugin Registry`}</h1>
				<p className="mt-1 text-sm leading-5 text-pretty text-kumo-subtle">
					{t`Browse and install plugins published to the decentralized registry.`}
				</p>
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
			{isSafetyRefreshPending ? (
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
					<Button
						type="button"
						variant="secondary"
						onClick={() => fetchNextPage()}
						disabled={isFetchingNextPage}
					>
						{isFetchingNextPage ? t`Loading...` : t`Load more`}
					</Button>
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
	// `profile` is lexicon-validated at the DiscoveryClient boundary, so the
	// shape is trustworthy (or `null`). These are plain text content
	// (React-escaped) — no URL/href, so no scheme allow-list is needed here.
	const name = pkg.profile?.name;
	const description = pkg.profile?.description;
	const license = pkg.profile?.license;

	return (
		<Link
			to="/plugins/marketplace/$pluginId"
			params={{ pluginId: `${pkg.did}/${pkg.slug}` }}
			className="block rounded-md border border-kumo-border bg-kumo-surface p-4 transition-colors hover:bg-kumo-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand"
		>
			<div className="flex items-start gap-3">
				<div className="mt-1 rounded-md bg-kumo-subtle p-2 text-kumo-subtle">
					<ADMIN_NAV_ICONS.plugins className="h-5 w-5" />
				</div>
				<div className="min-w-0 flex-1">
					<h2 className="truncate font-semibold">{name ?? pkg.slug}</h2>
					<PublisherIdentity did={pkg.did} profile={pkg.profile} variant="card" />

					{description ? (
						<p className="mt-2 line-clamp-2 text-sm text-kumo-default">{description}</p>
					) : null}
					{license ? <p className="mt-2 text-xs text-kumo-subtle">{license}</p> : null}
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
