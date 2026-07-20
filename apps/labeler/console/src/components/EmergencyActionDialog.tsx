import { Button, Dialog, Input, InputArea } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";
import type { EmergencyActionKind } from "../api/types.js";

interface EmergencyActionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	kind: EmergencyActionKind;
	mode: "issue" | "retract";
	subjectUri: string;
	/** The typed subject identifier the operator must retype: the record rkey for
	 * a release/package, the publisher DID's final `:`-segment for a publisher. */
	subjectConfirmationExpected: string;
	invalidateKeys: readonly (readonly unknown[])[];
}

/** The server-constant intent phrases, mirrored client-side for UX. The server
 * (`assertEmergencyConfirmation`) is authoritative and rejects a mismatch. */
const INTENT: Record<EmergencyActionKind, { issue: string; retract: string }> = {
	takedown: { issue: "CONFIRM TAKEDOWN", retract: "CONFIRM RETRACT" },
	"publisher-compromised": { issue: "CONFIRM COMPROMISE", retract: "CONFIRM RETRACT" },
};

const COPY: Record<
	EmergencyActionKind,
	Record<"issue" | "retract", { title: string; description: string; submit: string }>
> = {
	takedown: {
		issue: {
			title: "Emergency takedown",
			description:
				"Issues !takedown on this subject. It redacts the subject from official clients across all releases and stays active until an administrator retracts it.",
			submit: "Take down",
		},
		retract: {
			title: "Retract takedown",
			description:
				"Negates !takedown. The subject returns to its pre-takedown state — any automated blocks that were live before re-expose. Nothing is re-issued.",
			submit: "Retract takedown",
		},
	},
	"publisher-compromised": {
		issue: {
			title: "Mark publisher compromised",
			description:
				"Issues publisher-compromised on the publisher DID. Every release from this publisher is blocked until an administrator retracts it.",
			submit: "Mark compromised",
		},
		retract: {
			title: "Retract publisher-compromised",
			description: "Negates publisher-compromised for this publisher DID.",
			submit: "Retract",
		},
	},
};

/**
 * The high-friction admin ceremony for the emergency actions (spec §11.3/§18.2,
 * design §3): a required reason plus TWO typed confirmations — the subject
 * identifier and the fixed intent phrase — both server-validated pre-signing.
 * Danger-styled; the idempotency key is minted per open and reused across
 * retries so a network retry replays rather than double-issues.
 */
export function EmergencyActionDialog({
	open,
	onOpenChange,
	kind,
	mode,
	subjectUri,
	subjectConfirmationExpected,
	invalidateKeys,
}: EmergencyActionDialogProps) {
	const queryClient = useQueryClient();
	const copy = COPY[kind][mode];
	const expectedIntent = INTENT[kind][mode];
	const [reason, setReason] = useState("");
	const [subjectConfirmation, setSubjectConfirmation] = useState("");
	const [intent, setIntent] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setReason("");
		setSubjectConfirmation("");
		setIntent("");
	}, [open]);

	const mutation = useMutation({
		mutationFn: () =>
			apiClient.emergencyAction(kind, mode, {
				uri: subjectUri,
				subjectConfirmation,
				intent,
				reason,
				idempotencyKey,
			}),
		onSuccess: async () => {
			await Promise.all(
				invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			);
			onOpenChange(false);
		},
	});

	const subjectMatches =
		subjectConfirmation === subjectConfirmationExpected && subjectConfirmationExpected.length > 0;
	const intentMatches = intent === expectedIntent;
	const canSubmit =
		reason.trim().length > 0 && subjectMatches && intentMatches && !mutation.isPending;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
			<Dialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold text-kumo-danger">{copy.title}</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>

				<p className="rounded-lg bg-kumo-elevated p-3 text-sm text-kumo-subtle">
					{copy.description}
				</p>

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why this emergency action is being taken"
				/>

				<Input
					label="Type the subject identifier to confirm"
					value={subjectConfirmation}
					onChange={(event) => {
						setSubjectConfirmation(event.target.value);
					}}
					placeholder={subjectConfirmationExpected}
					error={
						subjectConfirmation.length > 0 && !subjectMatches
							? "Does not match the subject"
							: undefined
					}
				/>

				<Input
					label={`Type ${expectedIntent} to confirm`}
					value={intent}
					onChange={(event) => {
						setIntent(event.target.value);
					}}
					placeholder={expectedIntent}
					error={
						intent.length > 0 && !intentMatches ? "Does not match the required phrase" : undefined
					}
				/>

				{mutation.isError && (
					<p className="text-sm text-kumo-danger">
						{mutation.error instanceof Error ? mutation.error.message : "Emergency action failed"}
					</p>
				)}

				<div className="flex justify-end gap-2">
					<Dialog.Close render={(props) => <Button variant="secondary" {...props} />}>
						Cancel
					</Dialog.Close>
					<Button
						variant="destructive"
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
