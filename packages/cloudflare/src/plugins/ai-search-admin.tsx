/**
 * AI Search Plugin — Admin Components
 *
 * Settings page with a "Sync All Content" button that triggers
 * a full reindex of all configured collections into AI Search.
 */

import { Badge, Banner, Button, Combobox, Input, Loader } from "@cloudflare/kumo";
import {
	ArrowRight,
	ArrowsClockwise,
	CheckCircle,
	ListMagnifyingGlass,
	Plus,
	Trash,
} from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API_BASE = "/_emdash/api/plugins/ai-search";
const SCHEMA_API_BASE = "/_emdash/api/schema";

const indexedLabel = (n: number) => `${n} item${n !== 1 ? "s" : ""}`;

// =============================================================================
// Types
// =============================================================================

interface ReindexResult {
	jobId: string;
	status: "running" | "complete";
	done: boolean;
	onlyMissing: boolean;
	indexed: number;
	errors: number;
	skipped?: number;
	collections: string[];
}

interface CollectionOption {
	slug: string;
	label: string;
}

interface MissingItem {
	id: string;
	slug: string | null;
	title: string | null;
	status: string;
}

interface CollectionStatus {
	collection: string;
	eligible: number;
	indexed: number;
	missing: MissingItem[];
}

interface IndexStatus {
	instanceName: string;
	binding: string;
	hybridSearch: boolean;
	totalIndexed: number;
	collections: CollectionStatus[];
}

interface Synonym {
	from: string;
	to: string;
}

// =============================================================================
// Settings Page
// =============================================================================

function SettingsPage() {
	const [syncMode, setSyncMode] = React.useState<"full" | "missing" | null>(null);
	const isSyncing = syncMode !== null;
	const [result, setResult] = React.useState<ReindexResult | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [available, setAvailable] = React.useState<CollectionOption[]>([]);
	const [loadingCollections, setLoadingCollections] = React.useState(true);
	const [collectionsError, setCollectionsError] = React.useState<string | null>(null);
	const [selected, setSelected] = React.useState<string[]>([]);

	const [status, setStatus] = React.useState<IndexStatus | null>(null);
	const [isCheckingStatus, setIsCheckingStatus] = React.useState(false);
	const [statusError, setStatusError] = React.useState<string | null>(null);

	const [synonyms, setSynonyms] = React.useState<Synonym[]>([]);
	const [isSavingSynonyms, setIsSavingSynonyms] = React.useState(false);
	const [synonymsSaved, setSynonymsSaved] = React.useState(false);
	const [synonymsError, setSynonymsError] = React.useState<string | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const [collectionsRes, configRes] = await Promise.all([
					apiFetch(`${SCHEMA_API_BASE}/collections`),
					apiFetch(`${API_BASE}/config`),
				]);
				const collectionsData = await parseApiResponse<{ items: CollectionOption[] }>(
					collectionsRes,
				);
				const configData = await parseApiResponse<{
					collections: string[];
					synonyms?: Synonym[];
				}>(configRes);
				if (cancelled) return;

				setSynonyms(configData.synonyms ?? []);

				const options = collectionsData.items.map((c) => ({ slug: c.slug, label: c.label }));
				setAvailable(options);

				const valid = new Set(options.map((c) => c.slug));
				const saved = (configData.collections ?? []).filter((slug) => valid.has(slug));
				// Restore the last configured selection; fall back to the common
				// content collections when nothing has been configured yet.
				const initial =
					saved.length > 0
						? saved
						: options.filter((c) => c.slug === "posts" || c.slug === "pages").map((c) => c.slug);
				setSelected(initial);
			} catch (err) {
				if (!cancelled) {
					setCollectionsError(err instanceof Error ? err.message : "Failed to load collections");
				}
			} finally {
				if (!cancelled) setLoadingCollections(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const labelForSlug = React.useCallback(
		(slug: string) => available.find((c) => c.slug === slug)?.label ?? slug,
		[available],
	);

	// Persist the operator's selection so it is restored on the next visit.
	const persistSelection = React.useCallback((next: string[]) => {
		void apiFetch(`${API_BASE}/config`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ collections: next }),
		}).catch(() => {
			// Non-critical: selection still applies for this session.
		});
	}, []);

	const handleSelectionChange = React.useCallback(
		(value: unknown) => {
			const next = Array.isArray(value) ? (value as string[]) : [];
			setSelected(next);
			persistSelection(next);
		},
		[persistSelection],
	);

	const runSync = React.useCallback(
		async (body: Record<string, unknown>, mode: "full" | "missing") => {
			setSyncMode(mode);
			setError(null);
			try {
				const response = await apiFetch(`${API_BASE}/reindex`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				});
				let data = await parseApiResponse<ReindexResult | { error: string }>(response);
				if ("error" in data) throw new Error(data.error);
				setResult(data);

				while (!data.done) {
					await new Promise((resolve) => setTimeout(resolve, 5_000));
					const statusResponse = await apiFetch(`${API_BASE}/reindex`);
					const jobStatus = await parseApiResponse<ReindexResult | null>(statusResponse);
					if (!jobStatus || jobStatus.jobId !== data.jobId) {
						throw new Error("Reindex job not found");
					}
					data = jobStatus;
					setResult(data);
				}
			} catch (err) {
				setError(err instanceof Error ? err.message : "Sync failed");
			} finally {
				setSyncMode(null);
			}
		},
		[],
	);

	const handleSync = (onlyMissing = false) => {
		setResult(null);
		void runSync({ collections: selected, onlyMissing }, onlyMissing ? "missing" : "full");
	};

	React.useEffect(() => {
		void (async () => {
			try {
				const response = await apiFetch(`${API_BASE}/reindex`);
				const job = await parseApiResponse<ReindexResult | null>(response);
				if (job && !job.done) {
					await runSync({ jobId: job.jobId }, job.onlyMissing ? "missing" : "full");
				}
			} catch {
				// A missing prior job is normal.
			}
		})();
	}, [runSync]);

	const handleCheckStatus = async () => {
		setIsCheckingStatus(true);
		setStatus(null);
		setStatusError(null);
		try {
			const query = selected.length > 0 ? `?collections=${selected.join(",")}` : "";
			const response = await apiFetch(`${API_BASE}/status${query}`);
			const data = await parseApiResponse<IndexStatus | { error: string }>(response);
			if ("error" in data) {
				setStatusError(data.error);
			} else {
				setStatus(data);
			}
		} catch (err) {
			setStatusError(err instanceof Error ? err.message : "Failed to load status");
		} finally {
			setIsCheckingStatus(false);
		}
	};

	const updateSynonym = (index: number, patch: Partial<Synonym>) => {
		setSynonymsSaved(false);
		setSynonyms((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
	};

	const addSynonym = () => {
		setSynonymsSaved(false);
		setSynonyms((prev) => [...prev, { from: "", to: "" }]);
	};

	const removeSynonym = (index: number) => {
		setSynonymsSaved(false);
		setSynonyms((prev) => prev.filter((_, i) => i !== index));
	};

	const handleSaveSynonyms = async () => {
		setIsSavingSynonyms(true);
		setSynonymsSaved(false);
		setSynonymsError(null);
		// Drop incomplete rows before persisting.
		const cleaned = synonyms
			.map((s) => ({ from: s.from.trim(), to: s.to.trim() }))
			.filter((s) => s.from && s.to);
		try {
			const response = await apiFetch(`${API_BASE}/config`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ synonyms: cleaned }),
			});
			const data = await parseApiResponse<{ synonyms?: Synonym[]; error?: string }>(response);
			if (data.error) {
				setSynonymsError(data.error);
			} else {
				setSynonyms(data.synonyms ?? cleaned);
				setSynonymsSaved(true);
			}
		} catch (err) {
			setSynonymsError(err instanceof Error ? err.message : "Failed to save synonyms");
		} finally {
			setIsSavingSynonyms(false);
		}
	};

	return (
		<div className="space-y-6">
			<h1 className="text-3xl font-bold">AI Search</h1>

			<div className="rounded-lg border bg-kumo-base p-6">
				<h2 className="mb-1 text-lg font-semibold">Sync Content</h2>
				<p className="text-muted-foreground mb-4 text-sm">
					Re-upload all content to the search index. Content is indexed automatically on save — use
					this for a full re-sync after initial setup or to recover from issues.
				</p>

				<div className="space-y-4">
					{loadingCollections ? (
						<div className="flex items-center gap-2">
							<Loader size="sm" />
							<span className="text-muted-foreground text-sm">Loading collections…</span>
						</div>
					) : collectionsError ? (
						<Banner
							variant="error"
							title="Could not load collections"
							description={collectionsError}
						/>
					) : (
						<Combobox
							multiple
							label="Collections"
							description="Choose which collections to include in the sync."
							items={available.map((c) => c.slug)}
							value={selected}
							onValueChange={handleSelectionChange}
							className="max-w-sm"
						>
							<Combobox.TriggerMultipleWithInput
								placeholder="Select collections…"
								renderItem={(slug: string) => (
									<Combobox.Chip key={slug} value={slug} removeLabel="Remove">
										{labelForSlug(slug)}
									</Combobox.Chip>
								)}
							/>
							<Combobox.Content>
								<Combobox.Empty>No collections found</Combobox.Empty>
								<Combobox.List>
									{(slug: string) => (
										<Combobox.Item key={slug} value={slug}>
											{labelForSlug(slug)}
										</Combobox.Item>
									)}
								</Combobox.List>
							</Combobox.Content>
						</Combobox>
					)}

					<div className="flex items-center gap-3">
						<Button
							onClick={() => handleSync(false)}
							disabled={selected.length === 0 || loadingCollections || isSyncing}
							loading={syncMode === "full"}
							icon={<ArrowsClockwise />}
						>
							{syncMode === "full" ? "Syncing…" : "Sync All Content"}
						</Button>

						<Button
							variant="secondary"
							onClick={() => handleSync(true)}
							disabled={selected.length === 0 || loadingCollections || isSyncing}
							loading={syncMode === "missing"}
							icon={<ArrowsClockwise />}
						>
							{syncMode === "missing" ? "Syncing…" : "Sync Missing"}
						</Button>

						<Button
							variant="secondary"
							onClick={() => void handleCheckStatus()}
							disabled={selected.length === 0 || loadingCollections || isSyncing}
							loading={isCheckingStatus}
							icon={<ListMagnifyingGlass />}
						>
							Check Index Status
						</Button>

						{result && !error && (
							<span className="text-muted-foreground text-sm">
								{indexedLabel(result.indexed)} indexed
							</span>
						)}
					</div>

					{result?.done && (
						<Banner
							variant={result.errors > 0 ? "alert" : "default"}
							icon={<CheckCircle weight="fill" />}
							title="Sync complete"
							description={
								<>
									Indexed {indexedLabel(result.indexed)} across{" "}
									<span className="font-medium">{result.collections.join(", ")}</span>
									{result.skipped ? ` — ${result.skipped} already indexed` : ""}
									{result.errors > 0 && (
										<>
											{" "}
											— {result.errors} error{result.errors !== 1 ? "s" : ""}
										</>
									)}
								</>
							}
						/>
					)}

					{error && <Banner variant="error" title="Sync failed" description={error} />}

					{statusError && (
						<Banner variant="error" title="Could not load status" description={statusError} />
					)}

					{status && (
						<div className="space-y-3">
							<div className="text-muted-foreground text-sm">
								Instance <span className="font-medium">{status.instanceName}</span> (
								{status.binding}){" — "}
								{indexedLabel(status.totalIndexed)} indexed total
								{status.hybridSearch ? " · hybrid search" : ""}
							</div>
							{status.collections.map((c) => {
								const complete = c.missing.length === 0;
								return (
									<div key={c.collection} className="rounded-md border p-3">
										<div className="flex items-center justify-between gap-3">
											<span className="font-medium">{labelForSlug(c.collection)}</span>
											<Badge variant={complete ? "success" : "warning"}>
												{c.indexed} / {c.eligible} indexed
											</Badge>
										</div>
										{!complete && (
											<ul className="text-muted-foreground mt-2 space-y-1 text-sm">
												{c.missing.slice(0, 10).map((m) => (
													<li key={m.id}>
														{m.title || m.slug || m.id}{" "}
														<span className="opacity-70">({m.status})</span>
													</li>
												))}
												{c.missing.length > 10 && <li>…and {c.missing.length - 10} more</li>}
											</ul>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>
			</div>

			<div className="rounded-lg border bg-kumo-base p-6">
				<h2 className="mb-1 text-lg font-semibold">Synonyms</h2>
				<p className="text-muted-foreground mb-4 text-sm">
					Rewrite search queries before they reach the index. When a query contains a term on the
					left, it is transparently replaced with the term on the right — e.g. “autorag” → “AI
					Search”. Matching is whole-word and case-insensitive.
				</p>

				<div className="space-y-3">
					{synonyms.length === 0 && (
						<p className="text-muted-foreground text-sm">No synonyms configured.</p>
					)}

					{synonyms.map((syn, index) => (
						// eslint-disable-next-line react/no-array-index-key -- rows are positional; no stable id
						<div key={index} className="flex items-end gap-2">
							<Input
								label={index === 0 ? "Search term" : undefined}
								aria-label="Search term"
								value={syn.from}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									updateSynonym(index, { from: e.target.value })
								}
								placeholder="autorag"
								className="max-w-[12rem]"
							/>
							<ArrowRight className="mb-2.5 shrink-0 rtl:-scale-x-100" />
							<Input
								label={index === 0 ? "Replace with" : undefined}
								aria-label="Replace with"
								value={syn.to}
								onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
									updateSynonym(index, { to: e.target.value })
								}
								placeholder="AI Search"
								className="max-w-[12rem]"
							/>
							<Button
								variant="ghost"
								icon={<Trash />}
								aria-label="Remove synonym"
								onClick={() => removeSynonym(index)}
							/>
						</div>
					))}

					<div className="flex items-center gap-3">
						<Button variant="secondary" icon={<Plus />} onClick={addSynonym}>
							Add synonym
						</Button>
						<Button
							onClick={() => void handleSaveSynonyms()}
							loading={isSavingSynonyms}
							disabled={loadingCollections}
						>
							Save synonyms
						</Button>
						{synonymsSaved && <span className="text-muted-foreground text-sm">Saved</span>}
					</div>

					{synonymsError && (
						<Banner variant="error" title="Could not save synonyms" description={synonymsError} />
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
