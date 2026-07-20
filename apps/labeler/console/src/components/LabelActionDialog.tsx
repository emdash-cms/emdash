import { Badge, Button, Dialog, Input, InputArea, Loader } from "@cloudflare/kumo";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ulid } from "ulidx";

import { apiClient } from "../api/client.js";
import type { EffectPreview, IssuableLabel, ReleaseModeration } from "../api/types.js";

interface LabelActionDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	mode: "issue" | "retract";
	subjectUri: string;
	/** The release CID in view, used as the label CID for CID-bound actions. */
	subjectCid?: string;
	/** Menu of issuable labels for `mode: "issue"`. */
	issuable?: readonly IssuableLabel[];
	/** The label + scope being negated for `mode: "retract"`. */
	target?: IssuableLabel;
	/** TanStack Query keys to invalidate on success so the new state renders. */
	invalidateKeys: readonly (readonly unknown[])[];
}

function rkeyOf(uri: string): string {
	return uri.split("/").at(-1) ?? "";
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
					{value.warningLabels.map((v) => (
						<Badge key={`w-${v}`} variant="neutral">
							{v}
						</Badge>
					))}
				</div>
			) : (
				<span className="text-sm text-kumo-subtle">Not a release subject</span>
			)}
		</div>
	);
}

function EffectPreviewView({ preview }: { preview: EffectPreview }) {
	return (
		<div className="flex flex-col gap-3 rounded-lg bg-kumo-elevated p-3">
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-xs text-kumo-subtle">Label effect</span>
				<Badge variant="info">{preview.labelEffect}</Badge>
				<Badge variant="neutral">
					{preview.scope === "cid-bound" ? "This exact release CID" : "Whole record, all CIDs"}
				</Badge>
			</div>
			{preview.supersedes.length > 0 && (
				<div className="flex flex-col gap-1">
					<span className="text-xs text-kumo-subtle">Replaces active label</span>
					<div className="flex flex-wrap gap-1.5">
						{preview.supersedes.map((s) => (
							<Badge key={`${s.val}-${s.sequence}`} variant="neutral">
								{s.val}
							</Badge>
						))}
					</div>
				</div>
			)}
			<div className="grid grid-cols-2 gap-3">
				<ModerationSummary label="Before" value={preview.before} />
				<ModerationSummary label="After" value={preview.after} />
			</div>
		</div>
	);
}

/**
 * The §11.4 reviewer action ceremony: shows the subject, the resolved
 * official-client effect (server-derived), the CID-bound vs URI-wide scope, a
 * required reason, and a server-validated typed confirmation (the exact CID or
 * the record rkey). The client mirrors the confirmation check for UX; the server
 * is authoritative. The idempotency key is minted per open and reused across
 * retries so a network retry replays rather than double-issues.
 */
export function LabelActionDialog({
	open,
	onOpenChange,
	mode,
	subjectUri,
	subjectCid,
	issuable,
	target,
	invalidateKeys,
}: LabelActionDialogProps) {
	const queryClient = useQueryClient();
	const menu = issuable ?? [];
	const [selectedVal, setSelectedVal] = useState<string>(target?.val ?? menu[0]?.val ?? "");
	const [reason, setReason] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [idempotencyKey, setIdempotencyKey] = useState("");

	// Reset the ceremony each time the dialog opens: a fresh idempotency key, so a
	// reopened dialog is a genuinely new action, and cleared inputs.
	useEffect(() => {
		if (!open) return;
		setIdempotencyKey(ulid());
		setReason("");
		setConfirmation("");
		setSelectedVal(target?.val ?? menu[0]?.val ?? "");
		// menu/target are stable per open; re-running on their identity would clobber edits.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open]);

	const scope: IssuableLabel["scope"] =
		mode === "retract"
			? (target?.scope ?? "uri-wide")
			: (menu.find((entry) => entry.val === selectedVal)?.scope ?? "cid-bound");
	const cid = scope === "cid-bound" ? subjectCid : undefined;
	const expectedConfirmation = cid ?? rkeyOf(subjectUri);

	const previewQuery = useQuery({
		queryKey: ["effect-preview", subjectUri, selectedVal, cid ?? null, mode],
		queryFn: () =>
			apiClient.previewEffect({
				uri: subjectUri,
				val: selectedVal,
				...(cid === undefined ? {} : { cid }),
				neg: mode === "retract",
			}),
		enabled: open && selectedVal.length > 0,
	});

	const mutation = useMutation({
		mutationFn: () => {
			const input = {
				uri: subjectUri,
				val: selectedVal,
				...(cid === undefined ? {} : { cid }),
				confirmation,
				reason,
				idempotencyKey,
			};
			return mode === "retract" ? apiClient.retractLabel(input) : apiClient.issueLabel(input);
		},
		onSuccess: async () => {
			await Promise.all(
				invalidateKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })),
			);
			onOpenChange(false);
		},
	});

	const confirmationMatches =
		confirmation === expectedConfirmation && expectedConfirmation.length > 0;
	const canSubmit = reason.trim().length > 0 && confirmationMatches && !mutation.isPending;
	const title = mode === "retract" ? "Retract label" : "Issue label";

	return (
		<Dialog.Root
			open={open}
			onOpenChange={onOpenChange}
			role={mode === "retract" ? "alertdialog" : "dialog"}
		>
			<Dialog className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto p-6" size="lg">
				<Dialog.Title className="text-lg font-semibold">{title}</Dialog.Title>
				<Dialog.Description className="break-all font-mono text-xs text-kumo-subtle">
					{subjectUri}
				</Dialog.Description>

				{mode === "issue" && menu.length > 0 && (
					<label className="flex flex-col gap-1 text-sm">
						<span className="text-xs text-kumo-subtle">Label</span>
						<select
							aria-label="Label value"
							className="h-9 rounded-lg bg-kumo-elevated px-3 text-sm"
							value={selectedVal}
							onChange={(event) => {
								setSelectedVal(event.target.value);
								setConfirmation("");
							}}
						>
							{menu.map((entry) => (
								<option key={entry.val} value={entry.val}>
									{entry.val}
								</option>
							))}
						</select>
					</label>
				)}

				{previewQuery.isLoading ? (
					<div className="flex justify-center py-4">
						<Loader />
					</div>
				) : previewQuery.data ? (
					<EffectPreviewView preview={previewQuery.data} />
				) : previewQuery.isError ? (
					<p className="text-sm text-kumo-danger">Could not load the effect preview.</p>
				) : null}

				<InputArea
					label="Reason"
					value={reason}
					onValueChange={setReason}
					placeholder="Why this action is being taken"
				/>

				<Input
					label={
						scope === "cid-bound"
							? "Type the release CID to confirm"
							: "Type the record key to confirm"
					}
					value={confirmation}
					onChange={(event) => {
						setConfirmation(event.target.value);
					}}
					placeholder={expectedConfirmation}
					error={
						confirmation.length > 0 && !confirmationMatches
							? "Does not match the subject"
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
						variant={mode === "retract" ? "destructive" : "primary"}
						disabled={!canSubmit}
						onClick={() => {
							mutation.mutate();
						}}
					>
						{mutation.isPending ? "Submitting…" : title}
					</Button>
				</div>
			</Dialog>
		</Dialog.Root>
	);
}
