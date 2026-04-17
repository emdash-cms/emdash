/**
 * AI Search API Plugin — Admin Components
 *
 * Settings page with:
 * 1. Credentials form — save Cloudflare account ID + API token (stored in plugin KV)
 * 2. Sync button — trigger a full reindex of all configured collections
 *
 * IMPORTANT: Only use Tailwind utility classes that exist in the pre-compiled
 * admin CSS (packages/admin/dist/styles.css). The admin CSS is built once and
 * served statically — plugin sources are NOT scanned by Tailwind. Stick to
 * kumo semantic tokens (text-kumo-*, bg-kumo-*, border-kumo-*) and common
 * layout utilities.
 */

import { Badge, Button, Input } from "@cloudflare/kumo";
import {
	CircleNotch,
	ArrowsClockwise,
	CheckCircle,
	WarningCircle,
	Key,
} from "@phosphor-icons/react";
import type { PluginAdminExports } from "emdash";
import { apiFetch, parseApiResponse } from "emdash/plugin-utils";
import * as React from "react";

const API_BASE = "/_emdash/api/plugins/ai-search-api";

// =============================================================================
// Types
// =============================================================================

interface ReindexResult {
	indexed: number;
	errors: number;
	collections: string[];
}

interface StatusResponse {
	configured: boolean;
	source: "config" | "env" | "kv" | "none";
	accountId: string | null;
	namespace: string;
	instanceName: string;
}

interface CredentialsResponse {
	valid?: boolean;
	saved?: boolean;
	error?: string;
	reindex?: ReindexResult;
}

// =============================================================================
// Shared alert component
// =============================================================================

function Alert({
	variant,
	title,
	children,
}: {
	variant: "success" | "error";
	title: string;
	children: React.ReactNode;
}) {
	const Icon = variant === "success" ? CheckCircle : WarningCircle;
	const colorClass = variant === "success" ? "text-kumo-success" : "text-kumo-danger";
	const borderClass = variant === "success" ? "border-kumo-success" : "border-kumo-danger";
	return (
		<div className={`flex items-start gap-3 rounded-lg border ${borderClass} bg-kumo-tint p-4`}>
			<Icon className={`h-5 w-5 flex-shrink-0 ${colorClass}`} weight="fill" />
			<div>
				<div className={`text-sm font-medium ${colorClass}`}>{title}</div>
				<div className="mt-1 text-sm text-kumo-subtle">{children}</div>
			</div>
		</div>
	);
}

// =============================================================================
// Credentials Section
// =============================================================================

function CredentialsSection({
	status,
	onSaved,
}: {
	status: StatusResponse | null;
	onSaved: () => void;
}) {
	const [accountId, setAccountId] = React.useState("");
	const [apiToken, setApiToken] = React.useState("");
	const [isSaving, setIsSaving] = React.useState(false);
	const [result, setResult] = React.useState<CredentialsResponse | null>(null);

	const handleSave = async () => {
		setIsSaving(true);
		setResult(null);
		try {
			const response = await apiFetch(`${API_BASE}/credentials`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ accountId, apiToken }),
			});
			const data = await parseApiResponse<CredentialsResponse>(response);
			setResult(data);
			if (data.saved) {
				setApiToken("");
				onSaved();
			}
		} catch (err) {
			setResult({ error: err instanceof Error ? err.message : "Failed to save credentials" });
		} finally {
			setIsSaving(false);
		}
	};

	// Config-level credentials can't be changed in the UI
	if (status?.source === "config") {
		return (
			<section className="space-y-4">
				<div>
					<h2 className="text-lg font-semibold">Cloudflare Credentials</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						Credentials are configured in plugin code and cannot be changed here.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Badge color="green">Connected</Badge>
					<span className="text-sm text-kumo-subtle">
						Account: <code className="text-xs">{status.accountId}</code>
					</span>
				</div>
			</section>
		);
	}

	const isConfigured = status?.configured && (status.source === "kv" || status.source === "env");

	return (
		<section className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold">Cloudflare Credentials</h2>
				<p className="mt-1 text-sm text-kumo-subtle">
					Enter your Cloudflare account ID and an API token with AI Search permissions. Credentials
					saved here take priority over environment variables.
				</p>
			</div>

			{isConfigured && (
				<div className="flex items-center gap-2">
					<Badge color="green">Connected</Badge>
					<span className="text-sm text-kumo-subtle">
						via {status!.source === "kv" ? "saved credentials" : "environment variables"}
						{" — "}Account: <code className="text-xs">{status!.accountId}</code>
					</span>
				</div>
			)}

			<div className="space-y-4" style={{ maxWidth: "32rem" }}>
				<Input
					label="Account ID"
					value={accountId}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => setAccountId(e.target.value)}
					placeholder={status?.accountId ? `Current: ${status.accountId}` : "Cloudflare account ID"}
				/>

				<Input
					label="API Token"
					type="password"
					value={apiToken}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => setApiToken(e.target.value)}
					placeholder={isConfigured ? "••••••••" : "Cloudflare API token"}
					description={
						<>
							Create a token at{" "}
							<a
								href="https://dash.cloudflare.com/profile/api-tokens"
								target="_blank"
								rel="noopener noreferrer"
								className="text-kumo-link underline"
							>
								dash.cloudflare.com/profile/api-tokens
							</a>{" "}
							with <strong>AI Search Edit</strong> and <strong>AI Search Run</strong> permissions.
						</>
					}
				/>

				<Button
					onClick={handleSave}
					disabled={isSaving || !accountId.trim() || !apiToken.trim()}
					loading={isSaving}
				>
					<Key className="h-4 w-4" />
					{isConfigured ? "Update Credentials" : "Save & Index"}
				</Button>
			</div>

			{result?.saved && result.reindex && (
				<Alert variant="success" title="Credentials saved & content indexed">
					Indexed {result.reindex.indexed} item
					{result.reindex.indexed !== 1 ? "s" : ""}
					{result.reindex.errors > 0 && (
						<>
							{" — "}
							{result.reindex.errors} error
							{result.reindex.errors !== 1 ? "s" : ""}
						</>
					)}
				</Alert>
			)}

			{result?.error && (
				<Alert variant="error" title="Validation failed">
					{result.error}
				</Alert>
			)}
		</section>
	);
}

// =============================================================================
// Sync Section
// =============================================================================

function SyncSection({ disabled }: { disabled: boolean }) {
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
		<section className="space-y-4">
			<div>
				<h2 className="text-lg font-semibold">Sync Content</h2>
				<p className="mt-1 text-sm text-kumo-subtle">
					Re-upload all content to the search index. Content is indexed automatically on save — use
					this for a full re-sync after initial setup or to recover from issues.
				</p>
			</div>

			<div className="space-y-4" style={{ maxWidth: "32rem" }}>
				<Input
					label="Collections"
					value={collections}
					onChange={(e: React.ChangeEvent<HTMLInputElement>) => setCollections(e.target.value)}
					placeholder="posts, pages"
					disabled={disabled}
					description="Comma-separated collection slugs to include in the sync."
				/>

				<div className="flex items-center gap-3">
					<Button
						onClick={handleSync}
						disabled={disabled || isSyncing || !collections.trim()}
						loading={isSyncing}
					>
						<ArrowsClockwise className="h-4 w-4" />
						{isSyncing ? "Syncing..." : "Sync All Content"}
					</Button>

					{result && !error && (
						<span className="text-sm text-kumo-subtle">
							{result.indexed} item{result.indexed !== 1 ? "s" : ""} indexed
						</span>
					)}
				</div>
			</div>

			{disabled && (
				<p className="text-sm text-kumo-warning">Configure credentials above before syncing.</p>
			)}

			{result && (
				<Alert variant="success" title="Sync complete">
					Indexed {result.indexed} item
					{result.indexed !== 1 ? "s" : ""} across <strong>{result.collections.join(", ")}</strong>
					{result.errors > 0 && (
						<>
							{" — "}
							{result.errors} error
							{result.errors !== 1 ? "s" : ""}
						</>
					)}
				</Alert>
			)}

			{error && (
				<Alert variant="error" title="Sync failed">
					{error}
				</Alert>
			)}
		</section>
	);
}

// =============================================================================
// Settings Page
// =============================================================================

function SettingsPage() {
	const [status, setStatus] = React.useState<StatusResponse | null>(null);
	const [loading, setLoading] = React.useState(true);

	const fetchStatus = React.useCallback(async () => {
		try {
			const response = await apiFetch(`${API_BASE}/status`);
			const data = await parseApiResponse<StatusResponse>(response);
			setStatus(data);
		} catch {
			setStatus({
				configured: false,
				source: "none",
				accountId: null,
				namespace: "",
				instanceName: "",
			});
		} finally {
			setLoading(false);
		}
	}, []);

	React.useEffect(() => {
		fetchStatus();
	}, [fetchStatus]);

	if (loading) {
		return (
			<div className="flex items-center gap-2 p-6 text-kumo-subtle">
				<CircleNotch className="h-4 w-4 animate-spin" />
				<span className="text-sm">Loading...</span>
			</div>
		);
	}

	return (
		<div className="space-y-6">
			<h1 className="text-2xl font-bold">AI Search</h1>
			<CredentialsSection status={status} onSaved={fetchStatus} />
			<hr className="border-kumo-line" />
			<SyncSection disabled={!status?.configured} />
		</div>
	);
}

// =============================================================================
// Exports
// =============================================================================

export const pages: PluginAdminExports["pages"] = {
	"/settings": SettingsPage,
};
