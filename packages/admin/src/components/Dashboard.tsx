import { Badge, Banner, LayerCard, SkeletonLine } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	Upload,
	CircleDashed,
	CheckCircle,
	PencilSimple,
	Image,
	Users,
} from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";

import type { AdminManifest } from "../lib/api";
import type { CollectionStats, DashboardStats, RecentItem } from "../lib/api/dashboard";
import { fetchDashboardStats } from "../lib/api/dashboard";
import { usePluginWidget } from "../lib/plugin-context";
import { formatRelativeTime } from "../lib/utils";
import { ArrowNext } from "./ArrowIcons";
import { RouterLinkButton } from "./RouterLinkButton";
import { SandboxedPluginWidget } from "./SandboxedPluginWidget";

export interface DashboardProps {
	manifest: AdminManifest;
}

/**
 * Admin dashboard — quick actions, status, collections, recent activity.
 */
export function Dashboard({ manifest }: DashboardProps) {
	const { t } = useLingui();
	const {
		data: stats,
		isLoading,
		isError,
	} = useQuery({
		queryKey: ["dashboard-stats"],
		queryFn: fetchDashboardStats,
		refetchOnWindowFocus: true,
	});

	return (
		<div className="space-y-6">
			<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
				<h1 className="text-3xl font-bold">{t`Dashboard`}</h1>
				<QuickActions manifest={manifest} />
			</div>

			{isError && <DashboardDataError />}

			{(!isError || stats) && (
				<>
					<SummaryMetrics stats={stats} loading={isLoading} />

					{/* Collections + Recent activity */}
					<div className="grid gap-6 lg:grid-cols-2">
						<CollectionList
							collections={stats?.collections ?? []}
							manifest={manifest}
							loading={isLoading}
						/>
						<RecentActivity items={stats?.recentItems ?? []} loading={isLoading} />
					</div>
				</>
			)}

			{/* Plugin widgets */}
			<PluginWidgets manifest={manifest} />
		</div>
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

// --- Quick actions ---

function QuickActions({ manifest }: { manifest: AdminManifest }) {
	const { t } = useLingui();
	const collections = Object.entries(manifest.collections);

	return (
		<div className="flex flex-wrap items-center gap-2">
			{collections.map(([slug, config]) => (
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
			<RouterLinkButton to="/media" variant="secondary" icon={<Upload aria-hidden="true" />}>
				{t`Upload Media`}
			</RouterLinkButton>
		</div>
	);
}

// --- Summary metrics ---

function SummaryMetrics({ stats, loading }: { stats?: DashboardStats; loading: boolean }) {
	if (loading) {
		return (
			<div className="grid gap-4 sm:grid-cols-3">
				{[1, 2, 3].map((i) => (
					<LayerCard key={i}>
						<LayerCard.Secondary>
							<SkeletonLine minWidth={45} maxWidth={70} />
						</LayerCard.Secondary>
						<LayerCard.Primary className="text-2xl font-semibold">
							<SkeletonLine minWidth={20} maxWidth={35} />
						</LayerCard.Primary>
					</LayerCard>
				))}
			</div>
		);
	}

	if (!stats) return null;

	const totalDrafts = stats.collections.reduce((sum, c) => sum + c.draft, 0);

	const metrics: Array<{ icon: React.ElementType; label: string; value: number }> = [
		{
			icon: PencilSimple,
			label: plural(totalDrafts, { one: "Draft", other: "Drafts" }),
			value: totalDrafts,
		},
		{
			icon: Image,
			label: plural(stats.mediaCount, { one: "Media file", other: "Media files" }),
			value: stats.mediaCount,
		},
		{
			icon: Users,
			label: plural(stats.userCount, { one: "User", other: "Users" }),
			value: stats.userCount,
		},
	];

	return (
		<div className="grid gap-4 sm:grid-cols-3">
			{metrics.map((metric) => (
				<LayerCard key={metric.label}>
					<LayerCard.Secondary className="flex items-center gap-2 text-kumo-subtle">
						<metric.icon className="h-4 w-4" aria-hidden="true" />
						<span>{metric.label}</span>
					</LayerCard.Secondary>
					<LayerCard.Primary className="text-2xl font-semibold tabular-nums">
						{metric.value}
					</LayerCard.Primary>
				</LayerCard>
			))}
		</div>
	);
}

function SkeletonRows({ count }: { count: number }) {
	return (
		<div className="space-y-3 px-3">
			{Array.from({ length: count }, (_, i) => (
				<SkeletonLine key={i} blockHeight={40} minWidth={65} maxWidth={95} />
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

	return (
		<LayerCard className="h-full">
			<LayerCard.Secondary>
				{/* px-3 matches the row Link inset below so the heading aligns with row text */}
				<h2 className="px-3">{t`Content`}</h2>
			</LayerCard.Secondary>
			<LayerCard.Primary className="flex-1">
				{loading ? (
					<SkeletonRows count={3} />
				) : collections.length === 0 ? (
					<p className="px-3 text-sm text-kumo-subtle">{t`No collections configured`}</p>
				) : (
					<div className="space-y-1">
						{collections.map((col) => {
							const config = manifest.collections[col.slug];
							return (
								<Link
									key={col.slug}
									to="/content/$collection"
									params={{ collection: col.slug }}
									search={{ locale: undefined }}
									className="group flex items-center justify-between gap-2 rounded-md px-3 py-2 hover:bg-kumo-tint"
								>
									<span className="font-medium">{config?.label ?? col.label}</span>
									<span className="flex shrink-0 items-center gap-2">
										<CountBadge
											icon={CheckCircle}
											count={col.published}
											variant="success"
											label={t`Published`}
										/>
										<CountBadge
											icon={PencilSimple}
											count={col.draft}
											variant="secondary"
											label={t`Drafts`}
										/>
										<ArrowNext
											className="h-3.5 w-3.5 text-kumo-subtle opacity-0 transition-opacity group-hover:opacity-100"
											aria-hidden="true"
										/>
									</span>
								</Link>
							);
						})}
					</div>
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}

function CountBadge({
	icon: Icon,
	count,
	variant,
	label,
}: {
	icon: React.ElementType;
	count: number;
	variant: "success" | "secondary";
	label: string;
}) {
	if (count === 0) return null;
	return (
		<Badge variant={variant} className="gap-1">
			<Icon className="h-3 w-3" aria-hidden="true" />
			<span className="sr-only">{label}</span>
			{count}
		</Badge>
	);
}

// --- Recent activity ---

function RecentActivity({ items, loading }: { items: RecentItem[]; loading: boolean }) {
	const { t } = useLingui();

	return (
		<LayerCard className="h-full">
			<LayerCard.Secondary>
				{/* px-3 matches the row Link inset below so the heading aligns with row text */}
				<h2 className="px-3">{t`Recent Activity`}</h2>
			</LayerCard.Secondary>
			<LayerCard.Primary className="flex-1">
				{loading ? (
					<SkeletonRows count={5} />
				) : items.length === 0 ? (
					<p className="px-3 text-sm text-kumo-subtle">{t`No recent activity`}</p>
				) : (
					<div className="space-y-1">
						{items.map((item) => (
							<Link
								key={`${item.collection}-${item.id}`}
								to="/content/$collection/$id"
								params={{ collection: item.collection, id: item.id }}
								className="group flex items-center justify-between gap-2 rounded-md px-3 py-2 hover:bg-kumo-tint"
							>
								<div className="flex min-w-0 items-center gap-2">
									<StatusDot status={item.status} />
									<span className="truncate font-medium">
										{item.title || item.slug || t`Untitled`}
									</span>
									<span className="hidden shrink-0 text-xs text-kumo-subtle sm:inline">
										{item.collectionLabel}
									</span>
								</div>
								<span className="shrink-0 text-xs text-kumo-subtle">
									{formatRelativeTime(item.updatedAt)}
								</span>
							</Link>
						))}
					</div>
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}

function StatusDot({ status }: { status: string }) {
	const { t } = useLingui();

	// Semantic Kumo tokens (not raw text-green/amber/blue) render the same colors.
	const colors: Record<string, string> = {
		published: "text-kumo-success",
		draft: "text-kumo-warning",
		scheduled: "text-kumo-info",
	};
	const labels: Record<string, string> = {
		published: t`Published`,
		draft: t`Draft`,
		scheduled: t`Scheduled`,
		pending: t`Pending`,
		private: t`Private`,
		archived: t`Archived`,
	};

	const Icon = status === "published" ? CheckCircle : CircleDashed;
	return (
		<Icon
			className={`h-3.5 w-3.5 shrink-0 ${colors[status] ?? "text-kumo-subtle"}`}
			aria-label={labels[status] ?? t`Status: ${status}`}
		/>
	);
}

// --- Plugin widgets ---

function PluginWidgets({ manifest }: { manifest: AdminManifest }) {
	const widgets: Array<{
		id: string;
		pluginId: string;
		title?: string;
		size?: "full" | "half" | "third";
	}> = [];

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

	if (widgets.length === 0) {
		return null;
	}

	return (
		<div className="grid gap-6 lg:grid-cols-2">
			{widgets.map((widget) => (
				<PluginWidgetCard key={`${widget.pluginId}:${widget.id}`} widget={widget} />
			))}
		</div>
	);
}

function PluginWidgetCard({
	widget,
}: {
	widget: { id: string; pluginId: string; title?: string; size?: string };
}) {
	const WidgetComponent = usePluginWidget(widget.pluginId, widget.id);

	return (
		<LayerCard className="h-full">
			<LayerCard.Secondary>
				{/* px-3 matches the Content/Recent Activity card headings for cross-card alignment */}
				<h2 className="px-3">{widget.title || widget.id}</h2>
			</LayerCard.Secondary>
			<LayerCard.Primary className="flex-1">
				{/* px-3 aligns the widget body with the heading and the other cards' content */}
				<div className="px-3">
					{WidgetComponent ? (
						<WidgetComponent />
					) : (
						<SandboxedPluginWidget pluginId={widget.pluginId} widgetId={widget.id} />
					)}
				</div>
			</LayerCard.Primary>
		</LayerCard>
	);
}
