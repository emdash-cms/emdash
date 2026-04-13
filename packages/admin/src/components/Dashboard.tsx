import { useLingui } from "@lingui/react/macro";
import {
	Plus,
	Upload,
	ArrowRight,
	CircleDashed,
	CheckCircle,
	PencilSimple,
	CalendarBlank,
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
import { SandboxedPluginWidget } from "./SandboxedPluginWidget";

export interface DashboardProps {
	manifest: AdminManifest;
}

/**
 * Admin dashboard — quick actions, status, collections, recent activity.
 */
export function Dashboard({ manifest }: DashboardProps) {
	const { t } = useLingui();
	const { data: stats, isLoading } = useQuery({
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

			<StatusBar stats={stats} loading={isLoading} />

			{/* Collections + Recent activity */}
			<div className="grid gap-6 lg:grid-cols-2">
				<CollectionList
					collections={stats?.collections ?? []}
					manifest={manifest}
					loading={isLoading}
				/>
				<RecentActivity items={stats?.recentItems ?? []} loading={isLoading} />
			</div>

			{/* Plugin widgets */}
			<PluginWidgets manifest={manifest} />
		</div>
	);
}

// --- Quick actions ---

function QuickActions({ manifest }: { manifest: AdminManifest }) {
	const { t } = useLingui();
	const collections = Object.entries(manifest.collections);

	return (
		<div className="flex flex-wrap gap-2">
			{collections.map(([slug, config]) => (
				<Link
					key={slug}
					to="/content/$collection"
					params={{ collection: slug }}
					search={{ locale: undefined }}
					className="inline-flex items-center gap-1.5 rounded-md border bg-kumo-base px-3 py-1.5 text-sm font-medium transition-colors hover:bg-kumo-tint"
				>
					<Plus className="h-3.5 w-3.5" aria-hidden="true" />
					{config.labelSingular ?? config.label}
				</Link>
			))}
			<Link
				to="/media"
				className="inline-flex items-center gap-1.5 rounded-md border bg-kumo-base px-3 py-1.5 text-sm font-medium transition-colors hover:bg-kumo-tint"
			>
				<Upload className="h-3.5 w-3.5" aria-hidden="true" />
				{t`Upload Media`}
			</Link>
		</div>
	);
}

// --- Status bar ---

function StatusBar({ stats, loading }: { stats?: DashboardStats; loading: boolean }) {
	const { t } = useLingui();

	if (loading) {
		return <div className="flex h-9 animate-pulse rounded-lg border bg-kumo-tint" />;
	}

	if (!stats) return null;

	const totalDrafts = stats.collections.reduce((sum, c) => sum + c.draft, 0);
	const totalScheduled = stats.collections.reduce(
		(sum, c) => sum + (c.total - c.published - c.draft),
		0,
	);

	const indicators = [
		totalDrafts > 0 && {
			icon: PencilSimple,
			label: t`${totalDrafts} drafts`,
			className: "text-amber-700 dark:text-amber-400",
		},
		totalScheduled > 0 && {
			icon: CalendarBlank,
			label: t`${totalScheduled} scheduled`,
			className: "text-blue-600 dark:text-blue-400",
		},
		{
			icon: Image,
			label: t`${stats.mediaCount} media`,
			className: "text-kumo-subtle",
		},
		{
			icon: Users,
			label: t`${stats.userCount} users`,
			className: "text-kumo-subtle",
		},
	].filter(Boolean) as Array<{
		icon: React.ElementType;
		label: string;
		className: string;
	}>;

	return (
		<div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border bg-kumo-base px-4 py-2 text-sm">
			{indicators.map((ind) => (
				<span key={ind.label} className={`inline-flex items-center gap-1.5 ${ind.className}`}>
					<ind.icon className="h-3.5 w-3.5" aria-hidden="true" />
					{ind.label}
				</span>
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
		<div className="rounded-lg border bg-kumo-base p-4 sm:p-6">
			<h2 className="mb-4 text-lg font-semibold">{t`Content`}</h2>
			{loading ? (
				<div className="space-y-3">
					{[1, 2, 3].map((i) => (
						<div key={i} className="h-10 animate-pulse rounded-md bg-kumo-tint" />
					))}
				</div>
			) : collections.length === 0 ? (
				<p className="text-sm text-kumo-subtle">{t`No collections configured`}</p>
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
								className="group flex items-center justify-between rounded-md px-3 py-2 hover:bg-kumo-tint"
							>
								<span className="font-medium">{config?.label ?? col.label}</span>
								<span className="flex items-center gap-3 text-xs text-kumo-subtle">
									<CountBadge icon={CheckCircle} count={col.published} title={t`Published`} />
									<CountBadge icon={PencilSimple} count={col.draft} title={t`Drafts`} />
									<ArrowRight
										className="h-3.5 w-3.5 opacity-0 transition-opacity group-hover:opacity-100"
										aria-hidden="true"
									/>
								</span>
							</Link>
						);
					})}
				</div>
			)}
		</div>
	);
}

function CountBadge({
	icon: Icon,
	count,
	title,
}: {
	icon: React.ElementType;
	count: number;
	title: string;
}) {
	if (count === 0) return null;
	return (
		<span className="inline-flex items-center gap-1" title={title}>
			<Icon className="h-3 w-3" aria-hidden="true" />
			{count}
		</span>
	);
}

// --- Recent activity ---

function RecentActivity({ items, loading }: { items: RecentItem[]; loading: boolean }) {
	const { t } = useLingui();

	return (
		<div className="rounded-lg border bg-kumo-base p-4 sm:p-6">
			<h2 className="mb-4 text-lg font-semibold">{t`Recent Activity`}</h2>
			{loading ? (
				<div className="space-y-3">
					{[1, 2, 3, 4, 5].map((i) => (
						<div key={i} className="h-10 animate-pulse rounded-md bg-kumo-tint" />
					))}
				</div>
			) : items.length === 0 ? (
				<p className="text-sm text-kumo-subtle">{t`No recent activity`}</p>
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
		</div>
	);
}

function StatusDot({ status }: { status: string }) {
	const colors: Record<string, string> = {
		published: "text-green-500",
		draft: "text-amber-500",
		scheduled: "text-blue-500",
	};
	const Icon = status === "published" ? CheckCircle : CircleDashed;
	return (
		<Icon
			className={`h-3.5 w-3.5 shrink-0 ${colors[status] ?? "text-kumo-subtle"}`}
			aria-label={status}
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
		<div className="rounded-lg border bg-kumo-base p-4 sm:p-6">
			<h2 className="text-lg font-semibold mb-4">{widget.title || widget.id}</h2>
			{WidgetComponent ? (
				<WidgetComponent />
			) : (
				<SandboxedPluginWidget pluginId={widget.pluginId} widgetId={widget.id} />
			)}
		</div>
	);
}
