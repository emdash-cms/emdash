import { Button, Dialog, Input, InputArea } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";
import type { OverrideRetractResult, RerunResult } from "../api/types.js";

interface AssessmentActionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "rerun" | "override-retract";
	assessmentId: string;
	subjectUri: string;
	/** The exact release CID — the typed confirmation the reviewer must match. */
	subjectCid: string;
	/** TanStack Query keys to invalidate on success so the new state renders. */
	invalidateKeys: readonly (readonly unknown[])[];
}

const COPY = {
	rerun: {
		title: "Rerun assessment",
		description:
			"Creates a fresh assessment run for this exact release and re-issues assessment-pending. The release becomes ineligible until the new run completes.",
		submit: "Rerun",
		variant: "primary" as const,
	},
	"override-retract": {
		title: "Retract override",
		description:
			"Negates assessment-passed and assessment-overridden. The release returns to blocked (missing assessment pass). The original automated blocks stay negated — rerun to re-surface real findings.",
		submit: "Retract override",
		variant: "destructive" as const,
	},
};

/**
 * The §11.4 ceremony for the two single-purpose assessment actions (rerun,
 * override-retract): a required reason and a server-validated typed CID
 * confirmation, no effect preview (the effect is stated in the description). The
 * idempotency key is minted per open and reused across retries so a network
 * retry replays rather than repeats.
 */
export function AssessmentActionDialog({
	open,
	onOpenChange,
	mode,
	assessmentId,
	subjectUri,
	subjectCid,
	invalidateKeys,
}: AssessmentActionDialogProps) {
	const queryClient = useQueryClient();
	const copy = COPY[mode];
	const [reason, setReason] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setReason("");
		setConfirmation("");
	}, [open]);

	const mutation = useMutation<RerunResult | OverrideRetractResult>({
		mutationFn: () => {
			const input = { confirmation, reason, idempotencyKey };
			return mode === "rerun"
				? apiClient.rerunAssessment(assessmentId, input)
				: apiClient.retractOverride(assessmentId, input);
		},
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
				<Dialog.Title className="text-lg font-semibold">{copy.title}</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>

				<p className="text-sm text-kumo-subtle">{copy.description}</p>

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why this action is being taken"
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
						{mutation.error instanceof Error ? mutation.error.message : "Action failed"}
					</p>
				)}

				<div className="flex justify-end gap-2">
					<Dialog.Close render={(props) => <Button variant="secondary" {...props} />}>
						Cancel
					</Dialog.Close>
					<Button
						variant={copy.variant}
						disabled={!canSubmit}
						onClick={() => {
							mutation.mutate();
						}}
					>
						{mutation.isPending ? "Submitting…" : copy.submit}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
