import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";

interface OpenReconsiderationDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** The assessment whose subject the case is opened for. */
	assessmentId: string;
	subjectUri: string;
	invalidateKeys: readonly (readonly unknown[])[];
}

/**
 * Opens a reconsideration case for this assessment's subject, with a required
 * first note and reason. There is no by-subject lookup — a subject that already
 * has an open case surfaces the server's 409 inline. On success it navigates to
 * the new case detail. The idempotency key is minted per open and reused across
 * retries so a network retry replays rather than double-opens.
 */
export function OpenReconsiderationDialog({
	open,
	onOpenChange,
	assessmentId,
	subjectUri,
	invalidateKeys,
}: OpenReconsiderationDialogProps) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
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
		mutationFn: () => apiClient.openReconsideration({ assessmentId, note, reason, idempotencyKey }),
		onSuccess: async (result) => {
			await Promise.all(
				invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			);
			onOpenChange(false);
			await navigate({ to: "/reconsiderations/$id", params: { id: result.reconsiderationId } });
		},
	});

	const canSubmit = note.trim().length > 0 && reason.trim().length > 0 && !mutation.isPending;

	return (
		<Dialog.Root open={open} onOpenChange={onOpenChange} role="alertdialog">
			<Dialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">Open reconsideration</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>

				<p className="text-sm text-kumo-subtle">
					Opens a case to reconsider this release's assessment. A subject can have only one open
					case at a time.
				</p>

				<InputArea
					label="First note"
					value={note}
					onValueChange={setNote}
					placeholder="Why this assessment is being reconsidered"
				/>

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why this case is being opened"
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
						{mutation.isPending ? "Submitting…" : "Open reconsideration"}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
