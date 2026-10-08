import { Badge, Button, LinkButton, Loader } from "@cloudflare/kumo";
import { ArrowClockwise } from "@phosphor-icons/react";
import * as React from "react";

import { call, errorMessage, relativeTime, type RetryOutcome, SETTINGS_URL } from "./admin-api.js";
import type { EntryIndexState, EntryIndexStatus } from "./entry-status.js";

const POLL_MS = 3_000;
/** Indexing runs just after a save or publish responds, so recheck for a while after one. */
const SETTLE_MS = 30_000;
const SETTLING_STATES = new Set<EntryIndexState>(["outdated", "missing", "leftover"]);

type PanelStatus = { configured: false } | ({ configured: true } & EntryIndexStatus);

const STATES: Record<
	EntryIndexState,
	{
		label: string;
		variant: "success" | "warning" | "error" | "neutral";
		description: string;
		canSync?: true;
	}
> = {
	indexed: {
		label: "Indexed",
		variant: "success",
		description: "Search has the latest published version.",
	},
	processing: {
		label: "Processing",
		variant: "warning",
		description: "AI Search is processing the latest version.",
	},
	outdated: {
		label: "Out of date",
		variant: "warning",
		description: "Search still has an earlier version of this entry.",
		canSync: true,
	},
	missing: {
		label: "Not indexed",
		variant: "warning",
		description: "This entry should be in search but isn't yet.",
		canSync: true,
	},
	failed: {
		label: "Failed",
		variant: "error",
		description: "AI Search could not process this entry.",
		canSync: true,
	},
	leftover: {
		label: "Removing",
		variant: "warning",
		description: "This entry is still in search and will be removed.",
		canSync: true,
	},
	unpublished: {
		label: "Not indexed",
		variant: "neutral",
		description: "Only published entries appear in search.",
	},
	disabled: {
		label: "Not included",
		variant: "neutral",
		description: "This collection is not included in search.",
	},
	"no-url": {
		label: "Not indexed",
		variant: "neutral",
		description: "This entry has no public page, so search leaves it out.",
	},
	deleted: {
		label: "Not indexed",
		variant: "neutral",
		description: "This entry has been deleted.",
	},
};

const UPDATING = {
	label: "Updating",
	variant: "warning",
	description: "Sending the latest version to AI Search.",
} as const;

const REMOVING = {
	label: "Updating",
	variant: "warning",
	description: "Removing this entry from search.",
} as const;

const OUTCOME_MESSAGE: Record<RetryOutcome, string> = {
	synced: "Uploaded. AI Search will finish processing it shortly.",
	failed: "The upload failed.",
	busy: "AI Search is busy. Try again in a minute.",
};

/** The subset of the host's editor panel context this panel uses. */
interface EntryPanelProps {
	collection: string;
	entry: {
		id: string;
		status?: string;
		updatedAt?: string;
		liveRevisionId?: string | null;
	};
}

/** Editor sidebar section showing whether the saved entry is in AI Search. */
export function EntryIndexPanel({ collection, entry }: EntryPanelProps) {
	const [status, setStatus] = React.useState<PanelStatus | null>(null);
	const [error, setError] = React.useState<string | null>(null);
	const [notice, setNotice] = React.useState<string | null>(null);
	const [syncing, setSyncing] = React.useState(false);
	const record = React.useMemo(
		() => ({ source: collection, id: entry.id }),
		[collection, entry.id],
	);

	const load = React.useCallback(async () => {
		try {
			setStatus(await call<PanelStatus>("entry/status", record));
			setError(null);
		} catch (loadError) {
			setError(errorMessage(loadError));
		}
	}, [record]);

	const revision = [entry.status, entry.updatedAt, entry.liveRevisionId].join("|");
	React.useEffect(() => {
		void load();
	}, [load, revision]);

	const changedAt = entry.updatedAt ? Date.parse(entry.updatedAt) : 0;
	// The status can be read before the publish it follows is visible to the server.
	const behind =
		status?.configured === true && status.state === "unpublished" && entry.status === "published";
	const settling =
		status?.configured === true &&
		(SETTLING_STATES.has(status.state) || behind) &&
		Date.now() < changedAt + SETTLE_MS;
	const polling = settling || (status?.configured === true && status.state === "processing");
	React.useEffect(() => {
		if (!polling) return;
		const timer = setTimeout(() => void load(), POLL_MS);
		return () => clearTimeout(timer);
	}, [polling, status, load]);

	const sync = async () => {
		setSyncing(true);
		setNotice(null);
		try {
			const { outcome } = await call<{ outcome: RetryOutcome }>("entry/sync", record);
			setNotice(OUTCOME_MESSAGE[outcome]);
			await load();
		} catch (syncError) {
			setError(errorMessage(syncError));
		} finally {
			setSyncing(false);
		}
	};

	if (error && !status) return <p className="text-sm text-kumo-danger">{error}</p>;
	if (!status) return <Loader size="sm" />;
	if (!status.configured) {
		return (
			<div className="space-y-2 text-sm">
				<p className="text-kumo-subtle">AI Search is not set up yet.</p>
				<LinkButton variant="outline" size="sm" href={SETTINGS_URL}>
					Set up AI Search
				</LinkButton>
			</div>
		);
	}

	let state: (typeof STATES)[EntryIndexState] = STATES[status.state];
	if (settling) state = status.state === "leftover" ? REMOVING : UPDATING;
	const updated = relativeTime(status.updatedAt);
	const notes = [
		status.error && `AI Search reported: ${status.error}`,
		status.retry &&
			`The last upload failed: ${status.retry.error}. ${
				status.retry.automatic ? "Retrying automatically." : "Automatic retries stopped."
			}`,
	].filter(Boolean);
	return (
		<div className="space-y-3 text-sm">
			<div className="flex items-center justify-between gap-2">
				<Badge variant={state.variant}>{state.label}</Badge>
				{updated && status.state !== "missing" && (
					<span className="text-xs text-kumo-subtle">Updated {updated}</span>
				)}
			</div>
			<p className="text-kumo-subtle">{state.description}</p>
			{notes.map((note) => (
				<p key={note as string} className="text-xs text-kumo-danger">
					{note}
				</p>
			))}
			{status.foundBy && (
				<dl className="space-y-1 border-t border-kumo-line pt-2 text-xs">
					<dt className="font-medium text-kumo-subtle">Also found by</dt>
					{status.foundBy.map((line) => (
						<dd key={line.label}>
							<span className="text-kumo-subtle">{line.label}: </span>
							{line.values.join(", ")}
						</dd>
					))}
				</dl>
			)}
			{"canSync" in state && state.canSync && (
				<Button
					variant="outline"
					size="sm"
					icon={<ArrowClockwise />}
					loading={syncing}
					onClick={() => void sync()}
				>
					Sync now
				</Button>
			)}
			{notice && (
				<p className="text-xs" role="status">
					{notice}
				</p>
			)}
			{error && <p className="text-xs text-kumo-danger">{error}</p>}
		</div>
	);
}
