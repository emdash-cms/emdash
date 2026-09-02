import { Badge, Banner, Button, LayerCard, SkeletonLine, Tooltip } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowCounterClockwise,
	CircleNotch,
	Clock,
	Question,
	ArrowUpRight,
	Warning,
	XCircle,
} from "@phosphor-icons/react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import {
	MediaUsageAccessDeniedError,
	fetchManifest,
	fetchMediaUsageDetails,
	type AdminManifest,
	type MediaUsageCoverageStatus,
	type MediaUsageEntryDetail,
} from "../lib/api/index.js";
import { getCollectionNavIcon } from "./admin-navigation-icons.js";

const USAGE_PAGE_SIZE = 50;

export interface MediaUsedInProps {
	mediaId: string;
	open: boolean;
	navigationBlocked?: boolean;
	onEntryClick?: (event: React.MouseEvent<HTMLAnchorElement>, entry: MediaUsageEntryDetail) => void;
}

export function MediaUsedIn({ mediaId, open, navigationBlocked, onEntryClick }: MediaUsedInProps) {
	const { t } = useLingui();
	const headingId = React.useId();
	const { data: manifest } = useQuery({
		queryKey: ["manifest"],
		queryFn: fetchManifest,
		enabled: open,
	});
	const usageQuery = useInfiniteQuery({
		queryKey: ["media-usage", mediaId],
		queryFn: ({ pageParam, signal }) =>
			fetchMediaUsageDetails(mediaId, {
				cursor: pageParam,
				limit: USAGE_PAGE_SIZE,
				signal,
			}),
		initialPageParam: undefined as string | undefined,
		getNextPageParam: (lastPage) => lastPage.nextCursor,
		enabled: open,
		retry: false,
		refetchOnWindowFocus: false,
		refetchOnReconnect: false,
		refetchOnMount: "always",
		gcTime: 0,
	});

	const accessDenied = usageQuery.error instanceof MediaUsageAccessDeniedError;
	const pages = usageQuery.data?.pages ?? [];
	const entries = pages.flatMap((page) => page.items);
	const coverageStatus = aggregateCoverageStatus(pages.map((page) => page.coverage.status));
	const coverageComplete = coverageStatus === "complete";
	const refreshError = usageQuery.isError && pages.length > 0 && !usageQuery.isFetchNextPageError;
	const canRenderEmpty = usageQuery.isSuccess && !usageQuery.isFetching;
	let coverageIcon: React.ReactNode = null;
	let coverageMessage = "";
	let coverageTone = "";
	switch (coverageStatus) {
		case "running":
			coverageMessage = t`Usage is updating. Some content may not appear here yet.`;
			coverageTone = "text-kumo-info hover:text-kumo-info";
			coverageIcon = (
				<CircleNotch
					className="h-4 w-4 animate-spin motion-reduce:animate-none"
					weight="bold"
					aria-hidden="true"
				/>
			);
			break;
		case "never":
			coverageMessage = t`Usage indexing hasn’t started.`;
			coverageTone = "text-kumo-warning hover:text-kumo-warning";
			coverageIcon = <Clock className="h-4 w-4" weight="fill" aria-hidden="true" />;
			break;
		case "stale":
			coverageMessage = t`Usage may be out of date.`;
			coverageTone = "text-kumo-warning hover:text-kumo-warning";
			coverageIcon = <ArrowCounterClockwise className="h-4 w-4" weight="bold" aria-hidden="true" />;
			break;
		case "partial":
			coverageMessage = t`Some content may not appear here yet.`;
			coverageTone = "text-kumo-warning hover:text-kumo-warning";
			coverageIcon = <Warning className="h-4 w-4" weight="fill" aria-hidden="true" />;
			break;
		case "failed":
			coverageMessage = t`Usage indexing couldn’t finish.`;
			coverageTone = "text-kumo-danger hover:text-kumo-danger";
			coverageIcon = <XCircle className="h-4 w-4" weight="fill" aria-hidden="true" />;
			break;
		case "unknown":
			coverageMessage = t`Usage completeness couldn’t be verified.`;
			coverageTone = "text-kumo-subtle hover:text-kumo-subtle";
			coverageIcon = <Question className="h-4 w-4" weight="bold" aria-hidden="true" />;
			break;
	}

	let statusMessage = "";
	if (accessDenied) statusMessage = t`Usage details unavailable`;
	else if (usageQuery.isFetching && pages.length === 0) statusMessage = t`Loading usage`;
	else if (usageQuery.isFetching) statusMessage = t`Updating usage`;
	else if (pages.length > 0 && coverageMessage) statusMessage = coverageMessage;
	else if (pages.length > 0) statusMessage = t`Usage loaded`;

	return (
		<section
			className="flex h-full min-h-0 flex-col gap-4"
			aria-labelledby={headingId}
			aria-busy={usageQuery.isFetching || undefined}
			data-testid="media-used-in"
		>
			<div className="grid gap-1.5">
				<div className="flex items-center gap-2">
					<h3 id={headingId} className="text-base font-semibold text-kumo-default">
						{t`Used in`}
					</h3>
					{coverageIcon && coverageMessage && (
						<Tooltip
							content={coverageMessage}
							delay={0}
							closeDelay={0}
							render={
								<Button
									type="button"
									variant="ghost"
									shape="square"
									size="xs"
									icon={coverageIcon}
									className={coverageTone}
									aria-label={coverageMessage}
								/>
							}
						/>
					)}
				</div>
				<p className="text-sm text-kumo-subtle">{t`See where this file is used.`}</p>
			</div>
			<span className="sr-only" role="status">
				{statusMessage}
			</span>

			{accessDenied ? (
				<p className="text-sm text-kumo-subtle">
					{t`Usage details aren’t available for your account.`}
				</p>
			) : usageQuery.isLoading ? (
				<UsageSkeleton />
			) : usageQuery.isError && pages.length === 0 ? (
				<UsageError onRetry={() => void usageQuery.refetch()} />
			) : pages.length > 0 ? (
				<div className="flex min-h-0 flex-1 flex-col">
					{refreshError && <UsageError onRetry={() => void usageQuery.refetch()} />}

					{entries.length > 0 ? (
						<ul className="grid min-h-0 flex-1 grid-cols-2 content-start gap-3 overflow-y-auto overscroll-contain p-px">
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
					) : canRenderEmpty ? (
						<LayerCard className="grid justify-items-center gap-1.5 px-6 py-5 text-center">
							<p className="text-sm font-medium text-kumo-default">
								{coverageComplete ? t`No usage` : t`No usage to show yet`}
							</p>
							<p className="text-sm text-kumo-subtle">
								{coverageComplete
									? t`This file isn’t used in any content.`
									: t`Some content may not appear here yet.`}
							</p>
						</LayerCard>
					) : null}

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
			) : null}
		</section>
	);
}

function UsageSkeleton() {
	return (
		<div className="space-y-2" aria-hidden="true">
			<SkeletonLine blockHeight={40} minWidth={75} maxWidth={95} />
			<SkeletonLine blockHeight={40} minWidth={65} maxWidth={90} />
			<SkeletonLine blockHeight={40} minWidth={70} maxWidth={92} />
		</div>
	);
}

function UsageError({ onRetry }: { onRetry: () => void }) {
	const { t } = useLingui();
	return (
		<Banner
			variant="error"
			role="alert"
			title={t`Couldn’t load usage.`}
			action={
				<Button size="sm" variant="secondary" onClick={onRetry}>
					{t`Try again`}
				</Button>
			}
		/>
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
	const { i18n, t } = useLingui();
	const title = entry.title || entry.slug || t`Untitled`;
	const titleDirection = entry.title ? "auto" : entry.slug ? "ltr" : "auto";
	const manifestLabel = manifest?.collections[entry.collection]?.label;
	const collectionLabel = manifestLabel || entry.collection;
	const identifier = entry.slug || entry.contentId;
	const fieldSlugs = [
		...new Set(
			entry.sources.flatMap((source) =>
				source.occurrences.map((occurrence) => occurrence.fieldSlug),
			),
		),
	];
	const fieldLabels = fieldSlugs.map(
		(fieldSlug) => manifest?.collections[entry.collection]?.fields[fieldSlug]?.label || fieldSlug,
	);
	const usageLocation =
		fieldLabels.length > 0
			? new Intl.ListFormat(i18n.locale, { style: "short", type: "conjunction" }).format(
					fieldLabels,
				)
			: identifier;
	const showLocale = Boolean(manifest?.i18n && entry.locale);
	const CollectionIcon = getCollectionNavIcon(entry.collection);
	const content = (
		<>
			<span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-kumo-tint text-kumo-subtle">
				<CollectionIcon className="h-4 w-4" aria-hidden="true" />
			</span>
			<span className="min-w-0 flex-1 space-y-0.5">
				<span className="flex min-w-0 items-center gap-2">
					<span className="truncate text-sm font-medium text-kumo-default" dir={titleDirection}>
						{title}
					</span>
					{entry.deletedAt && (
						<Badge variant="neutral" className="shrink-0">
							{t`In trash`}
						</Badge>
					)}
				</span>
				<span className="flex min-w-0 items-center gap-1.5 text-sm text-kumo-subtle">
					<span className="min-w-0 truncate" dir={manifestLabel ? "auto" : "ltr"}>
						{collectionLabel}
					</span>
					<span className="shrink-0 text-kumo-inactive" aria-hidden="true">
						·
					</span>
					<span
						className={`min-w-0 truncate ${fieldLabels.length === 0 ? "font-mono" : ""}`}
						dir={fieldLabels.length === 0 ? "ltr" : "auto"}
						translate={fieldLabels.length === 0 ? "no" : undefined}
						title={usageLocation}
					>
						{usageLocation}
					</span>
					{showLocale && (
						<>
							<span className="shrink-0 text-kumo-inactive" aria-hidden="true">
								·
							</span>
							<span className="shrink-0" dir="ltr" translate="no">
								{entry.locale}
							</span>
						</>
					)}
				</span>
			</span>
			{!entry.deletedAt && (
				<span className="ms-auto flex shrink-0 items-center gap-1 text-sm font-medium text-kumo-subtle group-hover:text-kumo-default">
					{t`Open`}
					<ArrowUpRight className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
				</span>
			)}
		</>
	);
	const rowClassName =
		"group flex w-full min-w-0 items-center gap-3 rounded-lg bg-kumo-base px-3 py-3 text-start ring ring-kumo-line";

	if (entry.deletedAt) return <div className={rowClassName}>{content}</div>;

	return (
		<Link
			to="/content/$collection/$id"
			params={{ collection: entry.collection, id: entry.contentId }}
			search={{ locale: entry.locale ?? undefined }}
			className={`${rowClassName} hover:bg-kumo-tint focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand aria-disabled:cursor-not-allowed aria-disabled:opacity-60`}
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
): MediaUsageCoverageStatus | undefined {
	if (statuses.length === 0) return undefined;
	if (statuses.every((status) => status === "complete")) return "complete";
	if (statuses.includes("unknown")) return "unknown";
	if (statuses.includes("running")) return "running";
	if (statuses.includes("stale")) return "stale";
	if (statuses.includes("partial")) return "partial";
	if (statuses.every((status) => status === "never")) return "never";
	if (statuses.every((status) => status === "failed")) return "failed";
	return "partial";
}
