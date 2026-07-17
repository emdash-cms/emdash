import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";

interface ReconsiderationNoteDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	reconsiderationId: string;
	/** The case subject, shown for context. */
	subjectUri: string;
	/** TanStack Query keys to invalidate on success so the thread re-renders. */
	invalidateKeys: readonly (readonly unknown[])[];
}

/**
 * Appends one private note to a reconsideration case. A note is allowed in any
 * state (a resolved case still accepts post-hoc audit notes). A required note
 * body and reason gate submit; the idempotency key is minted per open and reused
 * across retries so a network retry replays rather than double-appends.
 */
export function ReconsiderationNoteDialog({
	open,
	onOpenChange,
	reconsiderationId,
	subjectUri,
	invalidateKeys,
}: ReconsiderationNoteDialogProps) {
	const queryClient = useQueryClient();
	const [note, setNote] = useState("");
	const [reason, setReason] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setNote("");
		setReason("");
	}, [open]);

	const mutation = useMutation({
		mutationFn: () =>
			apiClient.addReconsiderationNote(reconsiderationId, { note, reason, idempotencyKey }),
		onSuccess: async () => {
			await Promise.all(
				invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			);
			onOpenChange(false);
		},
	});

	const canSubmit = note.trim().length > 0 && reason.trim().length > 0 && !mutation.isPending;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
			<Dialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Add note</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>

				<InputArea
					label="Note"
					value={note}
					onValueChange={setNote}
					placeholder="A private note for the case thread"
				/>

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why this note is being recorded"
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
						{mutation.isPending ? "Submitting…" : "Add note"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
