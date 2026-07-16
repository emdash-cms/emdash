import { Button, Dialog, InputArea, Select } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";
import type { ReconsiderationOutcome } from "../api/types.js";

interface ReconsiderationResolveDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	reconsiderationId: string;
	/** The case subject, shown for context. */
	subjectUri: string;
	invalidateKeys: readonly (readonly unknown[])[];
}

const OUTCOMES: readonly ReconsiderationOutcome[] = ["granted", "denied", "withdrawn"];

const OUTCOME_LABEL: Record<ReconsiderationOutcome, string> = {
	granted: "Granted",
	denied: "Denied",
	withdrawn: "Withdrawn",
};

const OUTCOME_HELP: Record<ReconsiderationOutcome, string> = {
	granted: "The reconsideration succeeds — the publisher is notified of the granted outcome.",
	denied: "The reconsideration is refused — the publisher is notified of the denied outcome.",
	withdrawn: "The case is closed with no decision. No publisher notice is sent.",
};

/**
 * Resolves an open reconsideration: an outcome (granted / denied / withdrawn),
 * an optional final note, and a required reason. A `granted` / `denied` resolve
 * fires the publisher outcome notice; `withdrawn` notifies nothing. The server
 * rejects a resolve of an already-resolved case with a 409, surfaced inline.
 */
export function ReconsiderationResolveDialog({
	open,
	onOpenChange,
	reconsiderationId,
	subjectUri,
	invalidateKeys,
}: ReconsiderationResolveDialogProps) {
	const queryClient = useQueryClient();
	const [outcome, setOutcome] = useState<ReconsiderationOutcome>("granted");
	const [note, setNote] = useState("");
	const [reason, setReason] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setOutcome("granted");
		setNote("");
		setReason("");
	}, [open]);

	const mutation = useMutation({
		mutationFn: () =>
			apiClient.resolveReconsideration(reconsiderationId, {
				outcome,
				...(note.trim().length > 0 ? { note } : {}),
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

	const canSubmit = reason.trim().length > 0 && !mutation.isPending;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
			<Dialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Resolve reconsideration</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>

				<Select
					label="Outcome"
					value={outcome}
					onValueChange={(value) => {
						if (value) setOutcome(value);
					}}
				>
					{OUTCOMES.map((value) => (
						<Select.Option key={value} value={value}>
							{OUTCOME_LABEL[value]}
						</Select.Option>
					))}
				</Select>
				<p className="text-sm text-kumo-subtle">{OUTCOME_HELP[outcome]}</p>

				<InputArea
					label="Final note (optional)"
					value={note}
					onValueChange={setNote}
					placeholder="A closing note for the case thread"
				/>

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why this outcome was reached"
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
						variant="primary"
						disabled={!canSubmit}
						onClick={() => {
							mutation.mutate();
						}}
					>
						{mutation.isPending ? "Submitting…" : "Resolve"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
