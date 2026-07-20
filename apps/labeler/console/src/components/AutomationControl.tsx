import { Button, Dialog, InputArea, LayerCard } from "@cloudflare/kumo";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";

interface AutomationControlProps {
	paused: boolean;
	pausedReason: string | null;
	/** Cosmetic gating from `/whoami` — the server (`guardMutation`) is the
	 * enforcement boundary, so hiding the toggle never grants anything. */
	isAdmin: boolean;
}

/**
 * The admin-only global ingestion kill-switch control (spec §11.3, design §5).
 * Shows whether automated issuance is live or paused and, for an admin, toggles
 * it behind a required reason. Pausing halts Jetstream ingestion only — in-flight
 * work and manual/emergency issuance stay available. The idempotency key is
 * minted per dialog open and reused across retries so a network retry replays
 * rather than double-toggling.
 */
export function AutomationControl({ paused, pausedReason, isAdmin }: AutomationControlProps) {
	const queryClient = useQueryClient();
	const [open, setOpen] = useState(false);
	const [reason, setReason] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setReason("");
	}, [open]);

	const mutation = useMutation({
		mutationFn: () =>
			paused
				? apiClient.resumeAutomation({ reason, idempotencyKey })
				: apiClient.pauseAutomation({ reason, idempotencyKey }),
		onSuccess: async () => {
			await queryClient.invalidateQueries({ queryKey: ["system-status"] });
			setOpen(false);
		},
	});

	const canSubmit = reason.trim().length > 0 && !mutation.isPending;

	return (
		<LayerCard className={`flex flex-col gap-3 p-4 ${paused ? "border border-kumo-danger" : ""}`}>
			<div className="flex items-start justify-between gap-4">
				<div className="flex flex-col gap-1">
					<span className="text-sm text-kumo-subtle">Automated issuance</span>
					<span className={`text-2xl font-semibold ${paused ? "text-kumo-danger" : ""}`}>
						{paused ? "Paused" : "Active"}
					</span>
					{paused && pausedReason && (
						<span className="text-sm text-kumo-subtle">{pausedReason}</span>
					)}
				</div>
				{isAdmin && (
					<Button variant={paused ? "primary" : "destructive"} onClick={() => setOpen(true)}>
						{paused ? "Resume ingestion" : "Pause ingestion"}
					</Button>
				)}
			</div>

			<Dialog.Root open={open} onOpenChange={setOpen} role="alertdialog">
				<Dialog className="flex flex-col gap-4 p-6" size="base">
					<Dialog.Title className="text-lg font-semibold">
						{paused ? "Resume automated issuance" : "Pause automated issuance"}
					</Dialog.Title>
					<Dialog.Description className="text-sm text-kumo-subtle">
						{paused
							? "Resumes Jetstream ingestion. New releases are discovered and assessed automatically again."
							: "Halts Jetstream ingestion globally. Manual and emergency issuance are unaffected; queued releases retry until you resume."}
					</Dialog.Description>

					<InputArea
						label="Reason"
						value={reason}
						onValueChange={setReason}
						placeholder={
							paused ? "Why ingestion is being resumed" : "Why ingestion is being paused"
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
							variant={paused ? "primary" : "destructive"}
							disabled={!canSubmit}
							onClick={() => {
								mutation.mutate();
							}}
						>
							{mutation.isPending ? "Submitting…" : paused ? "Resume" : "Pause"}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
		</LayerCard>
	);
}
