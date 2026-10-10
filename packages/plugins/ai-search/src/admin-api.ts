import { apiFetch, getErrorMessage } from "emdash/plugin-utils";

import { AUTHORS } from "./authors.js";
import type { BuildState } from "./build.js";
import type { Config, SourceConfig, SourceInfo, TaxonomyInfo } from "./config.js";
import type { IndexTotals } from "./ingestion.js";
import { URL_TEMPLATE } from "./url-template.js";

export type { Activity, ActivityItem, AttentionGroup, AttentionRecord } from "./activity.js";
export type { Example } from "./examples.js";
export type { RetryOutcome } from "./retry.js";

export const API = "/_emdash/api/plugins/ai-search";
export const SETTINGS_URL = "/_emdash/admin/plugins/ai-search/settings";

/** Part of the settings page that `settingsUrl` can open: a tab, or the index activity column. */
export type SettingsTab = "content" | "relevance" | "activity";

export const settingsUrl = (tab: SettingsTab) => `${SETTINGS_URL}?tab=${tab}`;

/** The settings tab named in the page address, if any. */
export function tabFromUrl(): SettingsTab | null {
	const tab = new URLSearchParams(window.location.search).get("tab");
	return tab === "content" || tab === "relevance" || tab === "activity" ? tab : null;
}

/** Admin editor of a record, or null for sources without one. */
export const editUrl = (source: string, id: string) =>
	source === AUTHORS
		? null
		: `/_emdash/admin/content/${encodeURIComponent(source)}/${encodeURIComponent(id)}`;

export { AUTHORS };

export interface Status {
	connected: boolean;
	configured: boolean;
	build: BuildState | null;
	totals: IndexTotals;
	/** Whether failed uploads still have an automatic retry to come. */
	retrying: boolean;
	/** Whether a build uploaded records recently enough that AI Search's stats may not show them yet. */
	recentBuild: boolean;
	/** When AI Search last changed an item. */
	lastActivity: string | null;
	/** Items per enabled source, in any state. Null while a build runs. */
	counts: Record<string, number> | null;
	/** The instance in the Cloudflare dashboard. Null while a build runs or when AI Search does not answer. */
	dashboardUrl: string | null;
}

export interface Settings {
	config: Config;
	saved: boolean;
	sources: SourceInfo[];
	taxonomies: TaxonomyInfo[];
}

/** A failed plugin route call, with its HTTP status. */
class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export async function call<T>(route: string, body?: unknown): Promise<T> {
	const init =
		body === undefined
			? undefined
			: {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				};
	const response = await apiFetch(`${API}/${route}`, init);
	if (!response.ok) {
		throw new ApiError(await getErrorMessage(response, "Request failed"), response.status);
	}
	const { data }: { data: T } = await response.json();
	return data;
}

export const isForbidden = (error: unknown) => error instanceof ApiError && error.status === 403;

export const errorMessage = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

const NEW_SOURCE: SourceConfig = { enabled: false, fields: [], weight: 2 };

/** A source's configuration, including sources added to the site after the config was saved. */
export function sourceOf(config: Config, id: string): SourceConfig {
	return config.sources[id] ?? NEW_SOURCE;
}

export function withSource(config: Config, id: string, change: Partial<SourceConfig>): Config {
	return {
		...config,
		sources: { ...config.sources, [id]: { ...sourceOf(config, id), ...change } },
	};
}

/**
 * The draft as it can be saved. A source left out of the index gets back its
 * address from `saved` when the draft holds an unfinished one, which the
 * server would reject even though the source is off.
 */
export function withoutInvalidAddresses(draft: Config, saved: Config): Config {
	const sources = Object.fromEntries(
		Object.entries(draft.sources).map(([id, source]) => {
			if (
				source.enabled ||
				source.urlTemplate === undefined ||
				URL_TEMPLATE.test(source.urlTemplate)
			) {
				return [id, source];
			}
			const { urlTemplate: _unfinished, ...rest } = source;
			const previous = saved.sources[id]?.urlTemplate;
			return [
				id,
				previous && URL_TEMPLATE.test(previous) ? { ...rest, urlTemplate: previous } : rest,
			];
		}),
	);
	return { ...draft, sources };
}

/** The sources the draft includes, in the settings' order. */
export function enabledSourceInfos(settings: Settings, draft: Config): SourceInfo[] {
	return settings.sources.filter((info) => sourceOf(draft, info.id).enabled);
}

/** Whether an included collection has no searchable field chosen. */
export function needsFields(info: SourceInfo, draft: Config): boolean {
	const source = sourceOf(draft, info.id);
	return source.enabled && info.fields.length > 0 && source.fields.length === 0;
}

export function kindOf(id: string): string {
	return id === AUTHORS ? "Optional page results" : "Collection";
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
	["day", 86_400_000],
	["hour", 3_600_000],
	["minute", 60_000],
];

/** "just now", "5 minutes ago", and so on. */
export function relativeTime(iso: string | undefined): string | null {
	const time = iso ? Date.parse(iso) : Number.NaN;
	if (Number.isNaN(time)) return null;
	const elapsed = Date.now() - time;
	const format = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
	for (const [unit, ms] of UNITS) {
		if (elapsed >= ms) return format.format(-Math.floor(elapsed / ms), unit);
	}
	return "just now";
}
