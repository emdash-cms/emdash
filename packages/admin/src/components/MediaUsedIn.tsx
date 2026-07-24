import { Badge, Banner, Button, SkeletonLine } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Warning } from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	fetchManifest,
	fetchMediaUsageDetails,
	type AdminManifest,
	type MediaUsageEntryDetail,
	type MediaUsageCoverageStatus,
	type MediaUsageSummary,
} from "../lib/api";
import { getCollectionNavIcon } from "./admin-navigation-icons.js";

const USAGE_PAGE_SIZE = 50;

export interface MediaUsedInProps {
	mediaId: string;
	open: boolean;
	summary?: MediaUsageSummary;
	navigationBlocked?: boolean;
	onEntryClick?: (event: React.MouseEvent<HTMLAnchorElement>, entry: MediaUsageEntryDetail) => void;
}

/** Entry-grouped content references for one local media item. */
export function MediaUsedIn({
	mediaId,
	open,
	summary,
	navigationBlocked,
	onEntryClick,
}: MediaUsedInProps) {
	const { t } = useLingui();
	const headingId = React.useId();
	const canReadDetails = summary !== undefined && summary.count !== null;
	const queryEnabled = open && canReadDetails;

	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
		enabled: queryEnabled,
	});

	const usageQuery = useInfiniteQuery({
		queryKey: ["media-usage", mediaId],
		queryFn: ({ pageParam }) =>
			fetchMediaUsageDetails(mediaId, {
				limit: USAGE_PAGE_SIZE,
				cursor: pageParam,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		enabled: queryEnabled,
		staleTime: 0,
		refetchOnMount: "always",
	});

	if (!summary) return null;

	const entries = usageQuery.data?.pages.flatMap((page) => page.items) ?? [];
	const coverageStatus = aggregateCoverageStatus(
		usageQuery.data?.pages.map((page) => page.coverage.status) ?? [],
		summary.coverage.status,
	);
	const coverageComplete = coverageStatus === "complete";
	const countLabel =
		summary.count === 0 && (!usageQuery.isSuccess || entries.length > 0 || !coverageComplete)
			? null
			: summary.count;

	return (
		<section className="space-y-3" aria-labelledby={headingId} data-testid="media-used-in">
			<div className="flex items-center gap-2">
				<h3 id={headingId} className="text-sm font-medium text-kumo-default">
					{t`Used in`}
				</h3>
				{countLabel !== null && <span className="text-sm text-kumo-subtle">{countLabel}</span>}
			</div>

			{!canReadDetails ? (
				<p className="text-sm text-kumo-subtle">
					{t`Usage details aren’t available for your account.`}
				</p>
			) : usageQuery.isLoading ? (
				<UsageSkeleton />
			) : usageQuery.isError && usageQuery.data === undefined ? (
				<Banner
					variant="error"
					title={t`Couldn’t load usage.`}
					action={
						<Button size="sm" variant="secondary" onClick={() => void usageQuery.refetch()}>
							{t`Try again`}
						</Button>
					}
				/>
			) : (
				<div className="space-y-4">
					{!coverageComplete && (
						<Banner
							variant="alert"
							icon={<Warning weight="fill" aria-hidden="true" />}
							title={t`Usage may be incomplete`}
							description={t`Some content references may not be indexed yet.`}
						/>
					)}

					{entries.length === 0 ? (
						<p className="text-sm text-kumo-subtle">
							{coverageComplete
								? t`No usage found in EmDash-managed content fields.`
								: t`No indexed references are currently available.`}
						</p>
					) : (
						<ul className="space-y-2">
							{entries.map((entry) => (
								<li key={`${entry.collection}:${entry.contentId}`}>
									<UsageEntry
										entry={entry}
										manifest={manifest}
										navigationBlocked={navigationBlocked}
										onEntryClick={onEntryClick}
									/>
								</li>
							))}
						</ul>
					)}

					{usageQuery.hasNextPage && (
						<div className="flex flex-col items-start gap-2">
							{usageQuery.isFetchNextPageError && (
								<p className="text-sm text-kumo-danger">{t`Couldn’t load more usage.`}</p>
							)}
							<Button
								variant="outline"
								size="sm"
								onClick={() => void usageQuery.fetchNextPage()}
								disabled={usageQuery.isFetchingNextPage}
							>
								{usageQuery.isFetchingNextPage
									? t`Loading...`
									: usageQuery.isFetchNextPageError
										? t`Try again`
										: t`Load more`}
							</Button>
						</div>
					)}
				</div>
			)}
		</section>
	);
}

function UsageSkeleton() {
	const { t } = useLingui();
	return (
		<div className="space-y-2" role="status" aria-label={t`Loading usage`}>
			<SkeletonLine blockHeight={40} minWidth={75} maxWidth={95} />
			<SkeletonLine blockHeight={40} minWidth={65} maxWidth={90} />
			<SkeletonLine blockHeight={40} minWidth={70} maxWidth={92} />
		</div>
	);
}

function UsageEntry({
	entry,
	manifest,
	navigationBlocked,
	onEntryClick,
}: {
	entry: MediaUsageEntryDetail;
	manifest?: AdminManifest;
	navigationBlocked?: boolean;
	onEntryClick?: MediaUsedInProps["onEntryClick"];
}) {
	const { t } = useLingui();
	const title = entry.title || entry.slug || t`Untitled`;
	const collectionLabel = manifest?.collections[entry.collection]?.label ?? entry.collection;
	const identifier = entry.slug || entry.contentId;
	const showLocale = Boolean(manifest?.i18n && entry.locale);
	const CollectionIcon = getCollectionNavIcon(entry.collection);
	const content = (
		<>
			<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-kumo-tint text-kumo-subtle">
				<CollectionIcon className="h-4 w-4" aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1 space-y-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-base font-medium text-kumo-default" dir="auto">
						{title}
					</span>
					{entry.deletedAt && (
						<Badge variant="neutral" className="shrink-0">
							{t`In trash`}
						</Badge>
					)}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 text-base text-kumo-subtle">
					<span className="min-w-0 truncate" dir="auto">
						{collectionLabel}
					</span>
					<span className="shrink-0 text-kumo-inactive" aria-hidden="true">
						·
					</span>
					<span className="min-w-0 truncate font-mono text-[0.9em]" dir="ltr" title={identifier}>
						{identifier}
					</span>
					{showLocale && (
						<>
							<span className="shrink-0 text-kumo-inactive" aria-hidden="true">
								·
							</span>
							<span className="shrink-0" dir="ltr">
								{entry.locale}
							</span>
						</>
					)}
				</span>
			</span>
		</>
	);

	const rowClassName =
		"flex w-full min-w-0 items-center gap-3 rounded-md border border-kumo-line bg-kumo-control px-3 py-2.5 text-start";
	if (entry.deletedAt) {
		return <div className={rowClassName}>{content}</div>;
	}

	return (
		<Link
			to="/content/$collection/$id"
			params={{ collection: entry.collection, id: entry.contentId }}
			search={{ locale: entry.locale ?? undefined }}
			className={`${rowClassName} hover:bg-kumo-tint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand`}
			aria-disabled={navigationBlocked || undefined}
			onClick={(event) => {
				if (navigationBlocked) {
					event.preventDefault();
					return;
				}
				onEntryClick?.(event, entry);
			}}
			onAuxClick={(event) => {
				if (navigationBlocked) event.preventDefault();
			}}
		>
			{content}
		</Link>
	);
}

function aggregateCoverageStatus(
	statuses: readonly MediaUsageCoverageStatus[],
	fallback: MediaUsageCoverageStatus,
): MediaUsageCoverageStatus {
	if (statuses.length === 0) return fallback;
	if (statuses.every((status) => status === "complete")) return "complete";
	if (statuses.includes("unknown")) return "unknown";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("stale")) return "stale";
	if (statuses.includes("partial")) return "partial";
	if (statuses.every((status) => status === "never")) return "never";
	if (statuses.every((status) => status === "failed")) return "failed";
	return "partial";
}
