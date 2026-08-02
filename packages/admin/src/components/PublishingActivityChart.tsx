import { Banner, LayerCard, SkeletonLine } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import type { ActivityBucket, ActivityPeriod } from "../lib/api/dashboard";
import { fetchDashboardActivity } from "../lib/api/dashboard";
import { cn } from "../lib/utils";

// Six visually distinct colours that work in both light and dark Kumo themes
const COLLECTION_COLORS = [
	"bg-blue-500",
	"bg-violet-500",
	"bg-emerald-500",
	"bg-amber-500",
	"bg-rose-500",
	"bg-cyan-500",
];

function collectionColor(index: number): string {
	return COLLECTION_COLORS[index % COLLECTION_COLORS.length] ?? "bg-blue-500";
}

// --- Period switcher ---

interface PeriodOption {
	value: ActivityPeriod;
	label: string;
}

function PeriodSwitcher({
	value,
	onChange,
	options,
}: {
	value: ActivityPeriod;
	onChange: (p: ActivityPeriod) => void;
	options: PeriodOption[];
}) {
	return (
		<div className="flex gap-1" role="group">
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => onChange(opt.value)}
					className={cn(
						"rounded px-2 py-0.5 text-xs font-medium transition-colors",
						value === opt.value
							? "bg-kumo-brand text-white"
							: "text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-foreground",
					)}
					aria-pressed={value === opt.value}
				>
					{opt.label}
				</button>
			))}
		</div>
	);
}

// --- Tooltip ---

function Tooltip({
	bucket,
	collectionSlugs,
}: {
	bucket: ActivityBucket;
	collectionSlugs: string[];
}) {
	const { t } = useLingui();
	return (
		<div className="pointer-events-none absolute bottom-full left-1/2 z-50 mb-1.5 -translate-x-1/2 rounded-md border border-kumo-border bg-kumo-surface px-2 py-1.5 text-xs shadow-md">
			<p className="mb-1 font-semibold">{bucket.label}</p>
			{collectionSlugs.map((slug) => {
				const count = bucket.byCollection[slug] ?? 0;
				if (count === 0) return null;
				return (
					<p key={slug} className="text-kumo-subtle">
						{slug}: {count}
					</p>
				);
			})}
			<p className="mt-0.5 font-medium">
				{t`Total`}: {bucket.total}
			</p>
		</div>
	);
}

// --- Chart ---

function ActivityChart({
	buckets,
	collectionSlugs,
}: {
	buckets: ActivityBucket[];
	collectionSlugs: string[];
}) {
	const { t } = useLingui();
	const [hovered, setHovered] = React.useState<number | null>(null);

	const maxTotal = Math.max(...buckets.map((b) => b.total), 1);

	if (buckets.every((b) => b.total === 0)) {
		return (
			<p className="px-3 py-6 text-center text-sm text-kumo-subtle">
				{t`No published content in this period`}
			</p>
		);
	}

	return (
		<div className="px-3 pb-3">
			<div
				className="flex h-32 items-end gap-px overflow-hidden"
				role="img"
				aria-label={t`Publishing activity chart`}
			>
				{buckets.map((bucket, i) => {
					const heightPct = (bucket.total / maxTotal) * 100;
					return (
						<div
							key={bucket.label}
							className="group relative flex flex-1 flex-col-reverse"
							style={{ height: "100%" }}
							onMouseEnter={() => setHovered(i)}
							onMouseLeave={() => setHovered(null)}
						>
							{/* Stacked segments */}
							<div
								className="flex w-full flex-col-reverse overflow-hidden rounded-t-sm"
								style={{ height: `${heightPct}%` }}
							>
								{collectionSlugs.map((slug, ci) => {
									const count = bucket.byCollection[slug] ?? 0;
									if (count === 0) return null;
									const segPct = (count / bucket.total) * 100;
									return (
										<div
											key={slug}
											className={cn("w-full shrink-0", collectionColor(ci))}
											style={{ height: `${segPct}%` }}
										/>
									);
								})}
							</div>
							{hovered === i && <Tooltip bucket={bucket} collectionSlugs={collectionSlugs} />}
						</div>
					);
				})}
			</div>
			{/* X-axis: first and last label */}
			<div className="mt-1 flex justify-between text-[10px] text-kumo-subtle tabular-nums">
				<span>{buckets.at(0)?.label ?? ""}</span>
				<span>{buckets.at(-1)?.label ?? ""}</span>
			</div>
		</div>
	);
}

// --- Legend ---

function Legend({
	collectionSlugs,
	manifest,
}: {
	collectionSlugs: string[];
	manifest: Record<string, { label: string }>;
}) {
	if (collectionSlugs.length <= 1) return null;
	return (
		<div className="flex flex-wrap gap-x-3 gap-y-1 px-3 pb-3 text-xs text-kumo-subtle">
			{collectionSlugs.map((slug, i) => (
				<span key={slug} className="flex items-center gap-1">
					<span className={cn("inline-block h-2 w-2 rounded-full", collectionColor(i))} />
					{manifest[slug]?.label ?? slug}
				</span>
			))}
		</div>
	);
}

// --- Public component ---

export interface PublishingActivityChartProps {
	collectionManifest: Record<string, { label: string }>;
}

export function PublishingActivityChart({ collectionManifest }: PublishingActivityChartProps) {
	const { t } = useLingui();
	const [period, setPeriod] = React.useState<ActivityPeriod>("week");

	const { data, isLoading, isError } = useQuery({
		queryKey: ["dashboard-activity", period],
		queryFn: () => fetchDashboardActivity(period),
		refetchOnWindowFocus: false,
	});

	const periodOptions: PeriodOption[] = [
		{ value: "day", label: t`Daily` },
		{ value: "week", label: t`Weekly` },
		{ value: "month", label: t`Monthly` },
	];

	// All collection slugs that appear in any bucket, preserving manifest order
	const collectionSlugs = React.useMemo(() => {
		if (!data) return [];
		const inData = new Set(data.buckets.flatMap((b) => Object.keys(b.byCollection)));
		// Prefer manifest order; fall back to sorted for any not in manifest
		const ordered = Object.keys(collectionManifest).filter((s) => inData.has(s));
		const extras = [...inData].filter((s) => !collectionManifest[s]).sort();
		return [...ordered, ...extras];
	}, [data, collectionManifest]);

	return (
		<LayerCard>
			<LayerCard.Secondary>
				<div className="flex items-center justify-between px-3">
					<h2>{t`Publishing Activity`}</h2>
					<PeriodSwitcher value={period} onChange={setPeriod} options={periodOptions} />
				</div>
			</LayerCard.Secondary>
			<LayerCard.Primary>
				{isError && (
					<div className="px-3 pb-3">
						<Banner
							variant="error"
							title={t`Could not load activity data`}
							description={t`Refresh the page or try again.`}
						/>
					</div>
				)}
				{isLoading && (
					<div className="px-3 pb-3">
						<div className="flex h-32 items-end gap-px">
							{Array.from({ length: 12 }, (_, i) => (
								<div key={i} className="flex flex-1 flex-col-reverse" style={{ height: "100%" }}>
									<SkeletonLine
										blockHeight={Math.floor(20 + Math.random() * 80)}
										minWidth={100}
										maxWidth={100}
									/>
								</div>
							))}
						</div>
					</div>
				)}
				{data && !isLoading && (
					<>
						<ActivityChart buckets={data.buckets} collectionSlugs={collectionSlugs} />
						<Legend collectionSlugs={collectionSlugs} manifest={collectionManifest} />
					</>
				)}
			</LayerCard.Primary>
		</LayerCard>
	);
}
