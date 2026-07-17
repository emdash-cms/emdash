import { Badge, Button, LayerCard, Loader } from "@cloudflare/kumo";
import { useQuery } from "@tanstack/react-query";
import { createRoute, Link } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import { apiClient } from "../api/client.js";
import type { ReconsiderationNoteView } from "../api/types.js";
import { QueryError } from "../components/QueryError.js";
import {
	ReconsiderationOutcomeBadge,
	ReconsiderationStateBadge,
} from "../components/ReconsiderationBadges.js";
import { ReconsiderationNoteDialog } from "../components/ReconsiderationNoteDialog.js";
import { ReconsiderationResolveDialog } from "../components/ReconsiderationResolveDialog.js";
import { reconsiderationActorName } from "../reconsiderations.js";
import { shellRoute } from "./root.js";

function MetaRow({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="flex flex-col gap-0.5">
			<span className="text-xs text-kumo-subtle">{label}</span>
			<span className="text-sm">{value}</span>
		</div>
	);
}

function NoteCard({ note }: { note: ReconsiderationNoteView }) {
	return (
		<LayerCard className="flex flex-col gap-2 p-4">
			<div className="flex items-center gap-2">
				<span className="text-sm font-medium">
					{reconsiderationActorName({
						email: note.authorEmail,
						commonName: note.authorCommonName,
						id: note.authorId,
					})}
				</span>
				<Badge variant="neutral">{note.authorRole}</Badge>
				<span className="text-xs text-kumo-subtle">
					{new Date(note.createdAt).toLocaleString()}
				</span>
			</div>
			<p className="whitespace-pre-wrap text-sm">{note.note}</p>
		</LayerCard>
	);
}

function ReconsiderationDetail() {
	const { id } = reconsiderationDetailRoute.useParams();

	const { data, isLoading, isError, error } = useQuery({
		queryKey: ["reconsideration", id],
		queryFn: () => apiClient.getReconsideration(id),
	});
	const { data: whoami } = useQuery({ queryKey: ["whoami"], queryFn: () => apiClient.whoami() });
	const canAct = whoami?.roles.includes("reviewer") || whoami?.roles.includes("admin") || false;

	const [noteOpen, setNoteOpen] = useState(false);
	const [resolveOpen, setResolveOpen] = useState(false);

	if (isError) {
		return <QueryError title="Failed to load reconsideration" error={error} />;
	}

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-16">
				<Loader />
			</div>
		);
	}

	// A successful query that resolved to null is a genuine not-found, distinct
	// from isError above -- that branch already returned.
	if (!data) {
		return (
			<div className="p-8 text-center text-sm text-kumo-subtle">Reconsideration not found.</div>
		);
	}

	const { reconsideration: recon, notes } = data;
	const isOpen = recon.state === "open";
	const invalidateKeys: readonly (readonly unknown[])[] = [
		["reconsideration", id],
		["reconsiderations"],
	];

	return (
		<div className="flex flex-col gap-6">
			<div className="flex flex-col gap-2">
				<div className="flex items-center gap-2">
					<h1 className="text-xl font-semibold">Reconsideration</h1>
					<ReconsiderationStateBadge state={recon.state} />
					{recon.outcome && <ReconsiderationOutcomeBadge outcome={recon.outcome} />}
				</div>
				<span className="break-all font-mono text-sm text-kumo-subtle">{recon.subjectUri}</span>
				<p className="text-sm text-kumo-subtle">
					CID: <span className="font-mono">{recon.subjectCid}</span>
				</p>
			</div>

			<LayerCard className="grid grid-cols-2 gap-4 p-4 md:grid-cols-4">
				<MetaRow
					label="Triggering assessment"
					value={
						<Link
							to="/assessments/$id"
							params={{ id: recon.triggeringAssessmentId }}
							className="break-all font-mono text-kumo-link hover:underline"
						>
							{recon.triggeringAssessmentId}
						</Link>
					}
				/>
				<MetaRow
					label="Opened by"
					value={reconsiderationActorName({
						email: recon.openedByEmail,
						commonName: recon.openedByCommonName,
						id: recon.openedById,
					})}
				/>
				<MetaRow label="Opened at" value={new Date(recon.openedAt).toLocaleString()} />
				<MetaRow
					label="Resolved by"
					value={
						recon.resolvedAt
							? reconsiderationActorName({
									email: recon.resolvedByEmail,
									commonName: recon.resolvedByCommonName,
									id: recon.resolvedById ?? "",
								})
							: "—"
					}
				/>
				<MetaRow
					label="Resolved at"
					value={recon.resolvedAt ? new Date(recon.resolvedAt).toLocaleString() : "—"}
				/>
			</LayerCard>

			{canAct && (
				<div className="flex flex-wrap gap-2">
					<Button variant="secondary" onClick={() => setNoteOpen(true)}>
						Add note
					</Button>
					{isOpen && (
						<Button variant="primary" onClick={() => setResolveOpen(true)}>
							Resolve
						</Button>
					)}
				</div>
			)}

			<section className="flex flex-col gap-3">
				<h2 className="text-lg font-semibold">Notes</h2>
				{notes.length === 0 ? (
					<p className="text-sm text-kumo-subtle">No notes on this case.</p>
				) : (
					<div className="flex flex-col gap-3">
						{notes.map((note) => (
							<NoteCard key={note.id} note={note} />
						))}
					</div>
				)}
			</section>

			{canAct && (
				<>
					<ReconsiderationNoteDialog
						open={noteOpen}
						onOpenChange={setNoteOpen}
						reconsiderationId={id}
						subjectUri={recon.subjectUri}
						invalidateKeys={invalidateKeys}
					/>
					<ReconsiderationResolveDialog
						open={resolveOpen}
						onOpenChange={setResolveOpen}
						reconsiderationId={id}
						subjectUri={recon.subjectUri}
						invalidateKeys={invalidateKeys}
					/>
				</>
			)}
		</div>
	);
}

export const reconsiderationDetailRoute = createRoute({
	getParentRoute: () => shellRoute,
	path: "/reconsiderations/$id",
	component: ReconsiderationDetail,
});
