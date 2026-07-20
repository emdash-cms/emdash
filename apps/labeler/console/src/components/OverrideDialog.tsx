import { Badge, Button, Dialog, Input, InputArea, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";
import type { ReleaseModeration } from "../api/types.js";

interface OverrideDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	assessmentId: string;
	subjectUri: string;
	subjectCid: string;
	/** The active automated blocking labels to negate — the full observed set;
	 * the server validates it equals live state. */
	blocks: readonly string[];
	invalidateKeys: readonly (readonly unknown[])[];
}

function ModerationSummary({ label, value }: { label: string; value: ReleaseModeration | null }) {
	return (
		<div className="flex flex-col gap-1">
			<span className="text-xs text-kumo-subtle">{label}</span>
			{value ? (
				<div className="flex flex-wrap items-center gap-1.5">
					<Badge variant={value.eligibility === "eligible" ? "info" : "neutral"}>
						{value.eligibility}
					</Badge>
					{value.blockingLabels.map((v) => (
						<Badge key={`b-${v}`} variant="neutral">
							{v}
						</Badge>
					))}
					{value.suppressedLabels.map((v) => (
						<Badge key={`s-${v}`} variant="neutral">
							{v} (suppressed)
						</Badge>
					))}
				</div>
			) : (
				<span className="text-sm text-kumo-subtle">Not a release subject</span>
			)}
		</div>
	);
}

/**
 * The false-positive override ceremony (spec §7.1/§11.4): shows the exact release,
 * the full set of active automated blocks that will be negated, the server-derived
 * before→after effect (blocked → eligible-manual-override with the blocks
 * suppressed), and a warning that a later admin takedown still blocks. A required
 * reason and a typed CID confirmation gate submit; the idempotency key is minted
 * per open and reused across retries.
 */
export function OverrideDialog({
	open,
	onOpenChange,
	assessmentId,
	subjectUri,
	subjectCid,
	blocks,
	invalidateKeys,
}: OverrideDialogProps) {
	const queryClient = useQueryClient();
	const [reason, setReason] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setReason("");
		setConfirmation("");
	}, [open]);

	const previewQuery = useQuery({
		queryKey: ["override-effect-preview", subjectUri, subjectCid, [...blocks].toSorted()],
		queryFn: () =>
			apiClient.previewOverrideEffect({ uri: subjectUri, cid: subjectCid, negate: [...blocks] }),
		enabled: open,
	});

	const mutation = useMutation({
		mutationFn: () =>
			apiClient.overrideAssessment(assessmentId, {
				confirmation,
				reason,
				idempotencyKey,
				negate: [...blocks],
			}),
		onSuccess: async () => {
			await Promise.all(
				invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			);
			onOpenChange(false);
		},
	});

	const confirmationMatches = confirmation === subjectCid && subjectCid.length > 0;
	const canSubmit = reason.trim().length > 0 && confirmationMatches && !mutation.isPending;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
			<Dialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Override (unblock) release</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>
				<p className="font-mono text-xs text-kumo-subtle">CID: {subjectCid}</p>

				<div className="flex flex-col gap-1">
					<span className="text-xs text-kumo-subtle">
						Automated blocks to negate as false positives
					</span>
					{blocks.length > 0 ? (
						<div className="flex flex-wrap gap-1.5">
							{blocks.map((val) => (
								<Badge key={val} variant="neutral">
									{val}
								</Badge>
							))}
						</div>
					) : (
						<span className="text-sm text-kumo-subtle">No active automated blocks.</span>
					)}
				</div>

				{previewQuery.isLoading ? (
					<div className="flex justify-center py-4">
						<Loader />
					</div>
				) : previewQuery.data ? (
					<div className="grid grid-cols-2 gap-3 rounded-lg bg-kumo-elevated p-3">
						<ModerationSummary label="Before" value={previewQuery.data.before} />
						<ModerationSummary label="After" value={previewQuery.data.after} />
					</div>
				) : previewQuery.isError ? (
					<p className="text-sm text-kumo-danger">Could not load the override effect preview.</p>
				) : null}

				<p className="rounded-lg bg-kumo-elevated p-3 text-sm text-kumo-subtle">
					An override does not shield against a later administrator takedown or security-yank — a
					manual block still blocks this release.
				</p>

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why these findings are false positives"
				/>

				<Input
					label="Type the release CID to confirm"
					value={confirmation}
					onChange={(event) => {
						setConfirmation(event.target.value);
					}}
					placeholder={subjectCid}
					error={
						confirmation.length > 0 && !confirmationMatches
							? "Does not match the release CID"
							: undefined
					}
				/>

				{mutation.isError && (
					<p className="text-sm text-kumo-danger">
						{mutation.error instanceof Error ? mutation.error.message : "Override failed"}
					</p>
				)}

				<div className="flex justify-end gap-2">
					<Dialog.Close render={(props) => <Button variant="secondary" {...props} />}>
						Cancel
					</Dialog.Close>
					<Button
						variant="primary"
						disabled={!canSubmit}
						onClick={() => {
							mutation.mutate();
						}}
					>
						{mutation.isPending ? "Submitting…" : "Override"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
