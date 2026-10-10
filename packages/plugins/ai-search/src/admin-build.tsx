import { Loader, Meter } from "@cloudflare/kumo";
import { Check } from "@phosphor-icons/react";
import * as React from "react";

import { call } from "./admin-api.js";
import type { BuildState } from "./build.js";

/** Bounds on the wait before asking again while another runner has the build or it is paused. */
const MIN_RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;
const POLL_MS = 5_000;
const SLOW_POLL_MS = 20_000;

/**
 * Advances the build while the page is open, refreshing the status after each
 * step. The cron task finishes the build if the page is closed. A failed step
 * is reported and tried again later.
 */
export function useBuildRunner(
	running: boolean,
	refreshStatus: () => Promise<{ build: BuildState | null }>,
	onError: (error: unknown) => void,
) {
	const onErrorRef = React.useRef(onError);
	onErrorRef.current = onError;

	React.useEffect(() => {
		if (!running) return;
		const unmounted = new AbortController();
		void (async () => {
			while (!unmounted.signal.aborted) {
				try {
					const { build } = await call<{ build: BuildState | null }>("index/step", {});
					if (unmounted.signal.aborted) return;
					const status = await refreshStatus();
					if (!build && !status.build) return;
					if (build?.lease || build?.pausedUntil) await delay(retryDelay(build.pausedUntil));
				} catch (error) {
					if (unmounted.signal.aborted) return;
					onErrorRef.current(error);
					await delay(MAX_RETRY_MS);
				}
			}
		})();
		return () => unmounted.abort();
	}, [running, refreshStatus]);
}

/**
 * Refreshes the status while AI Search processes uploads, and less often while
 * failed uploads wait for an automatic retry or a build's uploads may not show
 * in AI Search's stats yet.
 */
export function useStatusPoll(
	status: {
		build: BuildState | null;
		totals: { processing: number };
		retrying: boolean;
		recentBuild: boolean;
	} | null,
	refreshStatus: () => Promise<unknown>,
) {
	let intervalMs: number | null = null;
	if (status && !status.build) {
		if (status.totals.processing > 0) intervalMs = POLL_MS;
		else if (status.retrying || status.recentBuild) intervalMs = SLOW_POLL_MS;
	}
	React.useEffect(() => {
		if (intervalMs === null) return;
		const timer = setInterval(() => void refreshStatus().catch(() => {}), intervalMs);
		return () => clearInterval(timer);
	}, [intervalMs, refreshStatus]);
}

/** The pause end is server time; clamp it so a skewed browser clock cannot stall or spin the loop. */
function retryDelay(pausedUntil: number | undefined): number {
	const remaining = pausedUntil ? pausedUntil - Date.now() : 0;
	return Math.min(MAX_RETRY_MS, Math.max(MIN_RETRY_MS, remaining));
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type SourceState = "Queued" | "Uploading" | "Uploaded";

/**
 * Per-source status and overall progress of a build, or of the finished build
 * over `sources`. Record totals are not known up front, so the bar advances by
 * source.
 */
export function BuildProgress(props: {
	build: BuildState | null;
	sources?: string[];
	labels: Map<string, string>;
}) {
	const { build } = props;
	const all = build?.all ?? props.sources ?? [];
	const remaining = build?.sources ?? [];
	const done = all.length - remaining.length;
	const stateOf = (id: string): SourceState => {
		if (!remaining.includes(id)) return "Uploaded";
		return id === remaining[0] ? "Uploading" : "Queued";
	};

	let summary = "All selected sources uploaded to AI Search.";
	if (build) {
		const failed = build.failed > 0 ? ` · ${build.failed.toLocaleString()} will be retried` : "";
		let note = "You can leave this page; uploading continues in the background.";
		if (build.pausedUntil) note = "Waiting for AI Search; uploading resumes shortly.";
		const records = build.processed === 1 ? "record" : "records";
		summary = `${build.processed.toLocaleString()} ${records} checked${failed}. ${note}`;
	}

	return (
		<section
			className="overflow-hidden rounded-xl border border-kumo-line bg-kumo-base"
			aria-busy={Boolean(build)}
		>
			<div className="space-y-2 px-4 py-3">
				<Meter
					label="Sources uploaded to AI Search"
					value={done}
					max={Math.max(all.length, 1)}
					customValue={`${done} of ${all.length}`}
				/>
				<p className="text-xs text-kumo-subtle" aria-live="polite">
					{summary}
				</p>
			</div>
			<ul className="divide-y divide-kumo-line border-t border-kumo-line">
				{all.map((id) => {
					const state = stateOf(id);
					return (
						<li key={id} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
							<span className="font-medium">{props.labels.get(id) ?? id}</span>
							<span
								className={`flex items-center gap-1.5 text-xs ${state === "Uploaded" ? "text-kumo-success" : "text-kumo-subtle"}`}
							>
								{state === "Uploading" && <Loader size="sm" />}
								{state === "Uploaded" && <Check aria-hidden="true" />}
								{state}
							</span>
						</li>
					);
				})}
			</ul>
		</section>
	);
}
