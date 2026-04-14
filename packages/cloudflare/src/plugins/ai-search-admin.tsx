/**
 * AI Search Plugin — Admin Components
 *
 * Settings page with a "Sync All Content" button that triggers
 * a full reindex of all configured collections into AI Search.
 */

import { CircleNotch, ArrowsClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API_BASE = "/_emdash/api/plugins/ai-search";

// =============================================================================
// Types
// =============================================================================

interface ReindexResult {
	indexed: number;
	errors: number;
	collections: string[];
}

// =============================================================================
// Settings Page
// =============================================================================

function SettingsPage() {
	const [isSyncing, setIsSyncing] = React.useState(false);
	const [result, setResult] = React.useState<ReindexResult | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [collections, setCollections] = React.useState("posts,pages");

	const handleSync = async () => {
		setIsSyncing(true);
		setResult(null);
		setError(null);
		try {
			const response = await apiFetch(`${API_BASE}/reindex`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					collections: collections
						.split(",")
						.map((c) => c.trim())
						.filter(Boolean),
				}),
			});
			const data = await parseApiResponse<ReindexResult | { error: string }>(response);
			if ("error" in data) {
				setError(data.error);
			} else {
				setResult(data);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Sync failed");
		} finally {
			setIsSyncing(false);
		}
	};

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold">AI Search</h1>

			<div className="rounded-lg border bg-kumo-base p-6">
				<h2 className="mb-1 text-lg font-semibold">Sync Content</h2>
				<p className="mb-4 text-sm text-kumo-subtle">
					Re-upload all content to the search index. Content is indexed automatically on save — use
					this for a full re-sync after initial setup or to recover from issues.
				</p>

				<div className="space-y-4">
					<div className="space-y-2">
						<label className="text-sm font-medium" htmlFor="ai-search-collections">
							Collections
						</label>
						<input
							id="ai-search-collections"
							type="text"
							value={collections}
							onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCollections(e.target.value)}
							placeholder="posts, pages"
							className="block w-full max-w-sm rounded-md border bg-kumo-base px-3 py-2 text-sm focus:border-kumo-brand focus:outline-none focus:ring-2 focus:ring-kumo-brand/20 transition-colors"
						/>
						<p className="text-xs text-kumo-subtle">
							Comma-separated collection slugs to include in the sync.
						</p>
					</div>

					<div className="flex items-center gap-3">
						<button
							onClick={handleSync}
							disabled={isSyncing || !collections.trim()}
							className="inline-flex items-center gap-2 rounded-md bg-kumo-brand px-4 py-2 text-sm font-medium text-white hover:bg-kumo-brand/90 disabled:opacity-50 transition-colors"
						>
							{isSyncing ? (
								<CircleNotch className="h-4 w-4 animate-spin" />
							) : (
								<ArrowsClockwise className="h-4 w-4" />
							)}
							{isSyncing ? "Syncing..." : "Sync All Content"}
						</button>

						{result && !error && (
							<span className="text-sm text-kumo-subtle">
								{result.indexed} item{result.indexed !== 1 ? "s" : ""} indexed
							</span>
						)}
					</div>

					{result && (
						<div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 p-4 dark:border-green-800 dark:bg-green-950/30">
							<CheckCircle
								className="h-5 w-5 flex-shrink-0 text-green-600 dark:text-green-400"
								weight="fill"
							/>
							<div>
								<div className="text-sm font-medium text-green-800 dark:text-green-200">
									Sync complete
								</div>
								<div className="mt-0.5 text-sm text-green-700 dark:text-green-300">
									Indexed {result.indexed} item{result.indexed !== 1 ? "s" : ""} across{" "}
									<span className="font-medium">{result.collections.join(", ")}</span>
									{result.errors > 0 && (
										<span className="text-amber-600 dark:text-amber-400">
											{" "}
											&mdash; {result.errors} error{result.errors !== 1 ? "s" : ""}
										</span>
									)}
								</div>
							</div>
						</div>
					)}

					{error && (
						<div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950/30">
							<WarningCircle
								className="h-5 w-5 flex-shrink-0 text-red-600 dark:text-red-400"
								weight="fill"
							/>
							<div>
								<div className="text-sm font-medium text-red-800 dark:text-red-200">
									Sync failed
								</div>
								<div className="mt-0.5 text-sm text-red-700 dark:text-red-300">{error}</div>
							</div>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

// =============================================================================
// Exports
// =============================================================================

export const pages: PluginAdminExports["pages"] = {
	"/settings": SettingsPage,
};
