import { Banner, Button, DropdownMenu, LayerCard, SkeletonLine } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CaretDown, FileArrowUp, Plus, Upload, X } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";

import type { AdminManifest } from "../lib/api";
import { useCurrentUser } from "../lib/api/current-user.js";
import type { CollectionStats, DashboardStats, RecentItem } from "../lib/api/dashboard";
import { dismissScheduledPolicyRejection, fetchDashboardStats } from "../lib/api/dashboard";
import { fetchTransferCapabilities, TRANSFER_CAPABILITIES_QUERY_KEY } from "../lib/api/transfer.js";
import { usePluginWidget } from "../lib/plugin-context";
import { cn, formatRelativeTime } from "../lib/utils.js";
import { getCollectionNavIcon } from "./admin-navigation-icons.js";
import { ArrowNext } from "./ArrowIcons";
import { ContentStatusIcon, type ContentStatusState } from "./ContentStatusBadge.js";
import { CoreUpdateBanner } from "./CoreUpdateBanner.js";
import { getMutationError } from "./DialogError.js";
import { MarketplaceMigrationBanner } from "./MarketplaceMigrationBanner.js";
import { RouterLinkButton } from "./RouterLinkButton";
import { SandboxedPluginWidget } from "./SandboxedPluginWidget";
import {
	declaredLabelTranslator,
	NavIcon,
	resolvePluginWidgetTitle,
	visibleCollectionEntries,
} from "./Sidebar.js";

const DASHBOARD_STATUS_STATES: Record<string, ContentStatusState> = {
	published: "published",
	draft: "draft",
	scheduled: "scheduled",
	pending: "pendingChanges",
	pending_changes: "pendingChanges",
	private: "private",
	archived: "archived",
};

const ROLE_ADMIN = 50;
const ROLE_EDITOR = 40;
const ROLE_CONTRIBUTOR = 20;

const SITE_IMPORT_HINT_DISMISSED_KEY = "emdash:dashboard:site-import-hint-dismissed";

const QUICK_ACTION_BUTTON_LIMIT = 3;
const REJECTION_PREVIEW_COUNT = 3;
const COLLECTION_COLLAPSE_AFTER = 12;
const COLLECTION_PREVIEW_COUNT = 10;

export interface DashboardProps {
	manifest: AdminManifest;
}

/**
 * Admin dashboard — quick actions, status, collections, recent activity.
 */
export function Dashboard({ manifest }: DashboardProps) {
	const { t } = useLingui();
	const { data: user } = useCurrentUser();
	const {
		data: stats,
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: fetchDashboardStats,
		refetchOnWindowFocus: true,
	});
	const hasDashboardData = stats !== undefined;
	const showDashboardData = !isError || hasDashboardData;
	const widgets = dashboardWidgets(manifest);
	const mainWidgets = widgets.filter((widget) => widget.size !== "third");
	const sideWidgets = widgets.filter((widget) => widget.size === "third");

	return (
		<div className="space-y-6">
			{manifest.marketplace && (user?.role ?? 0) >= ROLE_ADMIN && <MarketplaceMigrationBanner />}
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<h1 className="shrink-0 text-2xl font-semibold leading-tight">{t`Dashboard`}</h1>
				<QuickActions manifest={manifest} />
			</div>

			<CoreUpdateBanner />

			{isError && <DashboardDataError />}

			{showDashboardData && stats && (user?.role ?? 0) >= ROLE_ADMIN && (
				<SiteImportHint stats={stats} />
			)}
			{showDashboardData && stats && (
				<SchedulerWarning stats={stats} canDismissPolicy={(user?.role ?? 0) >= ROLE_EDITOR} />
			)}

			<div
				className={cn(
					"grid grid-cols-1 items-start gap-6 xl:grid-cols-3",
					mainWidgets.length > 0 && "xl:grid-rows-[auto_1fr]",
				)}
			>
				{showDashboardData && (
					<div className="min-w-0 space-y-6 xl:col-span-2">
						<SummaryMetrics
							stats={stats}
							loading={isLoading}
							linkCalendar={
								(user?.role ?? 0) >= ROLE_CONTRIBUTOR &&
								!manifest.admin?.hiddenNavItems?.includes("calendar")
							}
						/>
						<RecentActivity
							items={stats?.recentItems ?? []}
							loading={isLoading}
							multipleCollections={visibleCollectionEntries(manifest.collections).length > 1}
						/>
					</div>
				)}
				{(showDashboardData || sideWidgets.length > 0) && (
					<div
						className={cn(
							"min-w-0 space-y-6 xl:col-start-3 xl:row-start-1",
							mainWidgets.length > 0 && "xl:row-span-2",
						)}
					>
						{showDashboardData && (
							<CollectionList
								collections={stats?.collections ?? []}
								manifest={manifest}
								loading={isLoading}
							/>
						)}
						<PluginWidgetCards widgets={sideWidgets} />
					</div>
				)}
				{mainWidgets.length > 0 && (
					<div className="min-w-0 space-y-6 xl:col-span-2 xl:col-start-1">
						<PluginWidgetCards widgets={mainWidgets} />
					</div>
				)}
			</div>
		</div>
	);
}

/**
 * Expands a list that shows only its first `previewCount` rows, then moves focus to the first
 * revealed row, because the "Show more" button that had focus unmounts.
 */
function useRevealAll(previewCount: number) {
	const [showAll, setShowAll] = React.useState(false);
	const listRef = React.useRef<HTMLUListElement>(null);
	const focusRevealed = React.useRef(false);

	React.useEffect(() => {
		if (!showAll || !focusRevealed.current) return;
		focusRevealed.current = false;
		listRef.current?.children[previewCount]?.querySelector<HTMLElement>("a, button")?.focus();
	}, [showAll, previewCount]);

	const revealAll = () => {
		focusRevealed.current = true;
		setShowAll(true);
	};

	return { showAll, revealAll, listRef };
}

function SchedulerWarning({
	stats,
	canDismissPolicy,
}: {
	stats: DashboardStats;
	canDismissPolicy: boolean;
}) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const {
		showAll: showAllRejections,
		revealAll: revealAllRejections,
		listRef: rejectionListRef,
	} = useRevealAll(REJECTION_PREVIEW_COUNT);
	const dismissMutation = useMutation({
		mutationFn: ({
			collection,
			id,
			revision,
		}: {
			collection: string;
			id: string;
			revision: string;
		}) => dismissScheduledPolicyRejection(collection, id, revision),
		onSettled: async () => {
			await queryClient.invalidateQueries({ queryKey: ["dashboard-stats"] });
		},
	});
	const policyRejected = stats.policyRejectedScheduled ?? 0;
	const policyRejections = stats.policyRejections ?? [];
	const overdueCount = stats.collections.reduce(
		(sum, collection) => sum + (collection.overdueScheduled ?? 0),
		0,
	);
	const schedulerNeedsAttention =
		overdueCount > 0 &&
		stats.schedulerHealth !== undefined &&
		stats.schedulerHealth.status !== "healthy";
	if (policyRejected === 0 && !schedulerNeedsAttention) return null;

	const visibleRejections = showAllRejections
		? policyRejections
		: policyRejections.slice(0, REJECTION_PREVIEW_COUNT);
	const hiddenRejectionCount = policyRejections.length - visibleRejections.length;

	const schedulerDescription = schedulerNeedsAttention
		? stats.schedulerHealth!.status === "unknown"
			? plural(overdueCount, {
					one: "One scheduled item is overdue, but no scheduler run has completed. Run `npx emdash doctor` and verify the deployed Cron Trigger.",
					other:
						"# scheduled items are overdue, but no scheduler run has completed. Run `npx emdash doctor` and verify the deployed Cron Trigger.",
				})
			: plural(overdueCount, {
					one: "One scheduled item is overdue and the scheduler heartbeat is stale. Run `npx emdash doctor` and verify the deployed Cron Trigger.",
					other:
						"# scheduled items are overdue and the scheduler heartbeat is stale. Run `npx emdash doctor` and verify the deployed Cron Trigger.",
				})
		: "";

	return (
		<div className="space-y-3">
			{policyRejected > 0 && (
				<div className="space-y-2">
					<Banner
						variant="alert"
						title={t`Scheduled content was not published`}
						description={plural(policyRejected, {
							one: "Open the affected entry, fix the reason shown, and schedule it again. A successful schedule or publish clears this notice.",
							other:
								"Open the affected entries, fix the reasons shown, and schedule them again. A successful schedule or publish clears each notice.",
						})}
						role="alert"
					/>
					{policyRejections.length > 0 && (
						<LayerCard>
							<LayerCard.Primary className="gap-0 p-0">
								<ul ref={rejectionListRef} className="divide-y divide-kumo-line">
									{visibleRejections.map((rejection) => (
										<li
											key={`${rejection.collection}:${rejection.id}`}
											className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
										>
											<div className="min-w-0">
												<Link
													to="/content/$collection/$id"
													params={{ collection: rejection.collection, id: rejection.id }}
													className="font-medium wrap-anywhere text-kumo-brand hover:underline"
												>
													<bdi dir="ltr">
														{rejection.collection}/{rejection.id}
													</bdi>
												</Link>
												<p dir="auto" className="mt-1 text-pretty text-kumo-subtle">
													{rejection.reason}
												</p>
											</div>
											{canDismissPolicy && (
												<Button
													variant="secondary"
													size="sm"
													className="shrink-0 self-start"
													disabled={dismissMutation.isPending}
													onClick={() =>
														dismissMutation.mutate({
															collection: rejection.collection,
															id: rejection.id,
															revision: rejection._rev,
														})
													}
												>
													{t`Dismiss`}
												</Button>
											)}
										</li>
									))}
									{hiddenRejectionCount > 0 && (
										<li className="px-2 py-1.5">
											<Button variant="ghost" size="sm" onClick={revealAllRejections}>
												{plural(hiddenRejectionCount, {
													one: "Show # more entry",
													other: "Show # more entries",
												})}
											</Button>
										</li>
									)}
								</ul>
							</LayerCard.Primary>
						</LayerCard>
					)}
					{hiddenRejectionCount === 0 && policyRejected > policyRejections.length && (
						<p className="text-sm text-kumo-subtle">
							{plural(policyRejected - policyRejections.length, {
								one: "One more entry is not shown.",
								other: "# more entries are not shown.",
							})}
						</p>
					)}
					{dismissMutation.isError && (
						<p className="text-sm text-kumo-danger" role="alert">
							{getMutationError(dismissMutation.error) ??
								t`Failed to dismiss scheduled publication rejection`}
						</p>
					)}
				</div>
			)}
			{schedulerNeedsAttention && (
				<Banner
					variant="alert"
					title={t`Scheduled publishing needs attention`}
					description={schedulerDescription}
					role="alert"
				/>
			)}
		</div>
	);
}

function readSiteImportHintDismissed(): boolean {
	try {
		return window.localStorage.getItem(SITE_IMPORT_HINT_DISMISSED_KEY) === "1";
	} catch {
		return false;
	}
}

function SiteImportHint({ stats }: { stats: DashboardStats }) {
	const { t } = useLingui();
	const [dismissed, setDismissed] = React.useState(readSiteImportHintDismissed);
	// Any content or media rules out an import, so only ask the server when the
	// counts already loaded for the dashboard leave it possible.
	const mayBeEmpty =
		stats.mediaCount === 0 && stats.collections.every((collection) => collection.total === 0);
	const { data: capabilities } = useQuery({
		queryKey: TRANSFER_CAPABILITIES_QUERY_KEY,
		queryFn: fetchTransferCapabilities,
		enabled: !dismissed && mayBeEmpty,
	});

	if (dismissed || !mayBeEmpty || !capabilities?.portableDomain.empty) return null;

	const dismiss = () => {
		setDismissed(true);
		try {
			window.localStorage.setItem(SITE_IMPORT_HINT_DISMISSED_KEY, "1");
		} catch {
			// Without storage the hint stays hidden until the next page load.
		}
	};

	return (
		<Banner
			variant="secondary"
			icon={<FileArrowUp aria-hidden="true" />}
			title={t`Moving from another EmDash site?`}
			description={t`This site has no content yet, so you can import a .emdash package exported from another EmDash site.`}
			action={
				<div className="flex items-center gap-1">
					<RouterLinkButton
						to="/settings/transfer"
						search={{ start: "import" }}
						variant="secondary"
						size="sm"
					>
						{t`Import a site package`}
					</RouterLinkButton>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						shape="square"
						onClick={dismiss}
						aria-label={t`Dismiss import suggestion`}
					>
						<X className="h-4 w-4" aria-hidden="true" />
					</Button>
				</div>
			}
		/>
	);
}

function DashboardDataError() {
	const { t } = useLingui();

	return (
		<Banner
			variant="error"
			title={t`Could not load dashboard data`}
			description={t`Refresh the page or try again.`}
		/>
	);
}

function DashboardCardHeading({ children }: { children: React.ReactNode }) {
	return (
		<LayerCard.Secondary>
			<h2>{children}</h2>
		</LayerCard.Secondary>
	);
}

// --- Quick actions ---

function QuickActions({ manifest }: { manifest: AdminManifest }) {
	const { t } = useLingui();
	const collections = visibleCollectionEntries(manifest.collections).filter(
		([, config]) => config.quickCreate !== false,
	);

	const overflowing = collections.length > QUICK_ACTION_BUTTON_LIMIT;
	const inlineCount = overflowing ? QUICK_ACTION_BUTTON_LIMIT - 1 : collections.length;
	const inlineCollections = collections.slice(0, inlineCount);
	const menuCollections = collections.slice(inlineCount);

	return (
		<div className="flex flex-wrap items-center gap-2">
			{inlineCollections.map(([slug, config]) => (
				<RouterLinkButton
					key={slug}
					to="/content/$collection/new"
					params={{ collection: slug }}
					search={{ locale: undefined }}
					variant="secondary"
					icon={<Plus aria-hidden="true" />}
				>
					{config.labelSingular ?? config.label}
				</RouterLinkButton>
			))}
			{menuCollections.length > 0 && (
				<DropdownMenu>
					<DropdownMenu.Trigger
						render={
							<Button variant="secondary">
								{t`More`}
								<CaretDown className="size-3.5" aria-hidden="true" />
							</Button>
						}
					/>
					<DropdownMenu.Content align="end" className="min-w-52">
						<DropdownMenu.Group>
							<DropdownMenu.Label className="text-xs font-medium text-kumo-subtle">
								{t`New entry`}
							</DropdownMenu.Label>
							{menuCollections.map(([slug, config]) => {
								const Icon = getCollectionNavIcon(slug, config.icon);
								return (
									<DropdownMenu.LinkItem
										key={slug}
										closeOnClick
										icon={
											<NavIcon icon={Icon} className="size-4 text-kumo-subtle" isActive={false} />
										}
										render={
											<Link
												to="/content/$collection/new"
												params={{ collection: slug }}
												search={{ locale: undefined }}
											/>
										}
									>
										{config.labelSingular ?? config.label}
									</DropdownMenu.LinkItem>
								);
							})}
						</DropdownMenu.Group>
					</DropdownMenu.Content>
				</DropdownMenu>
			)}
			{!manifest.admin?.hiddenNavItems?.includes("media") && (
				<RouterLinkButton to="/media" variant="secondary" icon={<Upload aria-hidden="true" />}>
					{t`Upload Media`}
				</RouterLinkButton>
			)}
		</div>
	);
}

// --- Summary metrics ---

function SummaryMetrics({
	stats,
	loading,
	linkCalendar,
}: {
	stats?: DashboardStats;
	loading: boolean;
	/** Link the Scheduled count to the calendar, for roles that can open it. */
	linkCalendar: boolean;
}) {
	const { t, i18n } = useLingui();

	if (!loading && !stats) return null;

	let metrics: Array<{ label: string; value: number; calendar?: boolean }> = [];
	if (stats) {
		const totalDrafts = stats.collections.reduce((sum, c) => sum + c.draft, 0);
		const totalScheduled = stats.collections.reduce((sum, c) => sum + c.scheduled, 0);
		metrics = [
			{
				label: plural(totalDrafts, { one: "Draft", other: "Drafts" }),
				value: totalDrafts,
			},
			...(totalScheduled > 0
				? [
						{
							label: plural(totalScheduled, { one: "Scheduled", other: "Scheduled" }),
							value: totalScheduled,
							calendar: linkCalendar,
						},
					]
				: []),
			...(stats.mediaCount === undefined
				? []
				: [
						{
							label: plural(stats.mediaCount, { one: "Media file", other: "Media files" }),
							value: stats.mediaCount,
						},
					]),
			...(stats.userCount === undefined
				? []
				: [
						{
							label: plural(stats.userCount, { one: "User", other: "Users" }),
							value: stats.userCount,
						},
					]),
		];
	}

	return (
		<LayerCard>
			<DashboardCardHeading>{t`Overview`}</DashboardCardHeading>
			<LayerCard.Primary className="p-0">
				{loading ? (
					<div className={METRIC_GRID_CLASSES}>
						{[1, 2, 3].map((i) => (
							<div key={i} className={METRIC_CELL_CLASSES}>
								<SkeletonLine minWidth={45} maxWidth={70} />
								<SkeletonLine minWidth={20} maxWidth={35} />
							</div>
						))}
					</div>
				) : (
					<dl className={METRIC_GRID_CLASSES}>
						{metrics.map((metric) => (
							<div
								key={metric.label}
								data-testid="dashboard-metric"
								className={METRIC_CELL_CLASSES}
							>
								<dt className="text-kumo-subtle">
									{metric.calendar ? (
										<Link
											to="/calendar"
											className="group inline-flex items-center gap-1 rounded-sm hover:text-kumo-default focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
										>
											{metric.label}
											<ArrowNext
												aria-hidden="true"
												className="size-3.5 opacity-60 transition-opacity group-hover:opacity-100 motion-reduce:transition-none"
											/>
										</Link>
									) : (
										metric.label
									)}
								</dt>
								<dd
									data-testid="dashboard-metric-value"
									className="text-2xl leading-none font-semibold tabular-nums"
								>
									{i18n.number(metric.value)}
								</dd>
							</div>
						))}
					</dl>
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}

const METRIC_GRID_CLASSES =
	"grid divide-y divide-kumo-line sm:auto-cols-fr sm:grid-flow-col sm:divide-x sm:divide-y-0";

const METRIC_CELL_CLASSES =
	"flex items-center justify-between gap-3 px-4 py-3 sm:flex-col sm:items-start sm:justify-start sm:gap-3 sm:py-4";

const ROW_INTERACTION_CLASSES =
	"outline-none hover:bg-emdash-hover focus-visible:bg-emdash-hover focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:ring-inset";

const LIST_ROW_CLASSES = `flex h-11 items-center justify-between gap-3 px-4 ${ROW_INTERACTION_CLASSES}`;

function SkeletonRows({ count }: { count: number }) {
	return (
		<div className="space-y-3 p-4">
			{Array.from({ length: count }, (_, i) => (
				<SkeletonLine key={i} blockHeight={24} minWidth={65} maxWidth={95} />
			))}
		</div>
	);
}

// --- Collection list with counts ---

function CollectionList({
	collections,
	manifest,
	loading,
}: {
	collections: CollectionStats[];
	manifest: AdminManifest;
	loading: boolean;
}) {
	const { t } = useLingui();
	const { showAll, revealAll, listRef } = useRevealAll(COLLECTION_PREVIEW_COUNT);
	const visibleCollections = collections.filter((col) => !manifest.collections[col.slug]?.hidden);
	const shownCollections =
		showAll || visibleCollections.length <= COLLECTION_COLLAPSE_AFTER
			? visibleCollections
			: visibleCollections.slice(0, COLLECTION_PREVIEW_COUNT);
	const hiddenCount = visibleCollections.length - shownCollections.length;

	return (
		<LayerCard>
			<DashboardCardHeading>{t`Content`}</DashboardCardHeading>
			<LayerCard.Primary className="gap-0 p-0">
				{loading ? (
					<SkeletonRows count={3} />
				) : visibleCollections.length === 0 ? (
					<p className="px-4 py-3 text-pretty text-kumo-subtle">{t`No collections configured`}</p>
				) : (
					<ul ref={listRef} className="divide-y divide-kumo-line">
						{shownCollections.map((col) => {
							const config = manifest.collections[col.slug];
							const label = config?.label ?? col.label;
							return (
								<li key={col.slug}>
									<Link
										to="/content/$collection"
										params={{ collection: col.slug }}
										search={{ locale: undefined }}
										className={LIST_ROW_CLASSES}
									>
										<span dir="auto" title={label} className="truncate font-medium">
											{label}
										</span>
										<span className="flex shrink-0 items-center gap-3 text-kumo-subtle tabular-nums">
											{col.total === 0 ? (
												t`No entries`
											) : (
												<>
													<StatusCount
														state="published"
														count={col.published}
														label={t`Published`}
													/>
													<StatusCount state="draft" count={col.draft} label={t`Drafts`} />
												</>
											)}
										</span>
									</Link>
								</li>
							);
						})}
						{hiddenCount > 0 && (
							<li className="px-2 py-1.5">
								<Button variant="ghost" size="sm" onClick={revealAll}>
									{plural(hiddenCount, {
										one: "Show # more collection",
										other: "Show # more collections",
									})}
								</Button>
							</li>
						)}
					</ul>
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}

function StatusCount({
	state,
	count,
	label,
}: {
	state: ContentStatusState;
	count: number;
	label: string;
}) {
	const { i18n } = useLingui();
	if (count === 0) return null;
	return (
		<span className="inline-flex items-center gap-1">
			<ContentStatusIcon state={state} decorative />
			<span className="sr-only">{label}</span>
			{i18n.number(count)}
		</span>
	);
}

// --- Recent activity ---

function RecentActivity({
	items,
	loading,
	multipleCollections,
}: {
	items: RecentItem[];
	loading: boolean;
	multipleCollections: boolean;
}) {
	const { t, i18n } = useLingui();
	const showCollection =
		multipleCollections || new Set(items.map((item) => item.collection)).size > 1;

	return (
		<LayerCard>
			<DashboardCardHeading>{t`Recent Activity`}</DashboardCardHeading>
			<LayerCard.Primary className="gap-0 p-0">
				{loading ? (
					<SkeletonRows count={5} />
				) : items.length === 0 ? (
					<p className="px-4 py-3 text-pretty text-kumo-subtle">{t`No recent activity`}</p>
				) : (
					<ul
						className={cn(
							"grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 divide-y divide-kumo-line",
							showCollection && "sm:grid-cols-[minmax(0,1fr)_auto_auto]",
						)}
					>
						{items.map((item) => {
							const title = item.title || item.slug || t`Untitled`;
							return (
								<li
									key={`${item.collection}-${item.id}`}
									className="col-span-full grid grid-cols-subgrid"
								>
									<Link
										to="/content/$collection/$id"
										params={{ collection: item.collection, id: item.id }}
										className={cn(
											"col-span-full grid h-11 grid-cols-subgrid items-center px-4",
											ROW_INTERACTION_CLASSES,
										)}
									>
										<span className="flex min-w-0 items-center gap-2.5">
											<StatusDot status={item.status} />
											<span dir="auto" title={title} className="truncate font-medium">
												{title}
											</span>
										</span>
										{showCollection && (
											<span
												dir="auto"
												title={item.collectionLabel}
												className="hidden max-w-40 truncate text-kumo-subtle sm:block"
											>
												{item.collectionLabel}
											</span>
										)}
										<span
											data-testid="activity-time"
											className="text-end whitespace-nowrap text-kumo-subtle tabular-nums"
										>
											<bdi>{formatRelativeTime(item.updatedAt, i18n.locale)}</bdi>
										</span>
									</Link>
								</li>
							);
						})}
					</ul>
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}

function StatusDot({ status }: { status: string }) {
	const { t } = useLingui();
	const state = Object.hasOwn(DASHBOARD_STATUS_STATES, status)
		? DASHBOARD_STATUS_STATES[status]
		: undefined;

	return state ? (
		<ContentStatusIcon state={state} className="shrink-0" />
	) : (
		<span
			className="h-3.5 w-3.5 shrink-0 rounded-full bg-kumo-fill"
			role="img"
			aria-label={t`Status: ${status}`}
		/>
	);
}

// --- Plugin widgets ---

interface DashboardWidget {
	id: string;
	pluginId: string;
	title?: string;
	size?: "full" | "half" | "third";
}

function dashboardWidgets(manifest: AdminManifest): DashboardWidget[] {
	const widgets: DashboardWidget[] = [];

	for (const [pluginId, plugin] of Object.entries(manifest.plugins || {})) {
		if (plugin.enabled === false) continue;

		if ("dashboardWidgets" in plugin && Array.isArray(plugin.dashboardWidgets)) {
			for (const widget of plugin.dashboardWidgets) {
				widgets.push({
					id: widget.id,
					pluginId,
					title: widget.title,
					size: widget.size,
				});
			}
		}
	}

	return widgets;
}

function PluginWidgetCards({ widgets }: { widgets: DashboardWidget[] }) {
	return widgets.map((widget) => (
		<PluginWidgetCard key={`${widget.pluginId}:${widget.id}`} widget={widget} />
	));
}

function PluginWidgetCard({
	widget,
}: {
	widget: { id: string; pluginId: string; title?: string; size?: string };
}) {
	const { i18n } = useLingui();
	const WidgetComponent = usePluginWidget(widget.pluginId, widget.id);
	const title = resolvePluginWidgetTitle(
		widget.title,
		widget.id,
		declaredLabelTranslator(i18n, (id) => i18n._(id)),
	);

	return (
		<LayerCard>
			<DashboardCardHeading>{title}</DashboardCardHeading>
			<LayerCard.Primary>
				{WidgetComponent ? (
					<WidgetComponent />
				) : (
					<SandboxedPluginWidget pluginId={widget.pluginId} widgetId={widget.id} />
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}
