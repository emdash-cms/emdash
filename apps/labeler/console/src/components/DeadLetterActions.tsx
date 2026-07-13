import { Button, Dialog, InputArea } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";

type Action = "retry" | "quarantine";

interface DialogCopy {
	title: string;
	description: string;
	verb: string;
	placeholder: string;
	variant: "primary" | "destructive";
}

const DIALOG_COPY: Record<Action, DialogCopy> = {
	retry: {
		title: "Retry dead letter",
		description:
			"Re-enqueues the failed discovery event. The consumer re-fetches and re-verifies the record; a duplicate re-drive converges on a single assessment.",
		verb: "Confirm retry",
		placeholder: "Why this event is being re-driven",
		variant: "primary",
	},
	quarantine: {
		title: "Quarantine dead letter",
		description:
			"Marks the failed event reviewed and permanently excluded from retry. It leaves the dead-letter backlog and is not re-driven.",
		verb: "Confirm quarantine",
		placeholder: "Why this event is being quarantined",
		variant: "destructive",
	},
};

interface DeadLetterActionsProps {
	deadLetterId: number;
}

/**
 * The admin-only retry / quarantine controls for one `new` dead letter (design
 * §6). Each action runs behind a required-reason dialog; the idempotency key is
 * minted per dialog open and reused across retries so a network retry replays
 * rather than re-drives twice. The server (`guardMutation` admin gate) is the
 * enforcement boundary — the route only renders this for an admin.
 */
export function DeadLetterActions({ deadLetterId }: DeadLetterActionsProps) {
	const queryClient = useQueryClient();
	const [action, setAction] = useState<Action | null>(null);
	const [reason, setReason] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (action === null) return;
		setIdempotencyKey(ulid());
		setReason("");
	}, [action]);

	const mutation = useMutation({
		mutationFn: () =>
			action === "quarantine"
				? apiClient.quarantineDeadLetter(deadLetterId, { reason, idempotencyKey })
				: apiClient.retryDeadLetter(deadLetterId, { reason, idempotencyKey }),
		onSuccess: async () => {
			await Promise.all([
				queryClient.invalidateQueries({ queryKey: ["dead-letters"] }),
				queryClient.invalidateQueries({ queryKey: ["system-status"] }),
			]);
			setAction(null);
		},
	});

	const copy = action ? DIALOG_COPY[action] : null;
	const canSubmit = reason.trim().length > 0 && !mutation.isPending;

	return (
		<div className="flex justify-end gap-2">
			<Button variant="secondary" onClick={() => setAction("retry")}>
				Retry
			</Button>
			<Button variant="destructive" onClick={() => setAction("quarantine")}>
				Quarantine
			</Button>

			<Dialog.Root
				open={action !== null}
				onOpenChange={(open) => {
					if (!open) setAction(null);
				}}
				role="alertdialog"
			>
				<Dialog className="flex flex-col gap-4 p-6" size="base">
					{copy && (
						<>
							<Dialog.Title className="text-lg font-semibold">{copy.title}</Dialog.Title>
							<Dialog.Description className="text-sm text-kumo-subtle">
								{copy.description}
							</Dialog.Description>

							<InputArea
								label="Reason"
								value={reason}
								onValueChange={setReason}
								placeholder={copy.placeholder}
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
									{mutation.isPending ? "Submitting…" : copy.verb}
								</Button>
							</div>
						</>
					)}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
