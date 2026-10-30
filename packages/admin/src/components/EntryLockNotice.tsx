import { Button, LayerDialog } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";

import type { EntryLockHolder } from "../lib/api/entry-lock.js";
import type { EntryLockState } from "../lib/useEntryLock.js";
import { DialogError } from "./DialogError.js";

function holderName(holder: EntryLockHolder, fallback: string): string {
	return holder.userName?.trim() ? holder.userName : fallback;
}

/**
 * The dialog shown when the entry is already open elsewhere, and the banner
 * that keeps explaining it once the editor has answered.
 */
export function EntryLockNotice({
	state,
	onTakeOver,
	onReadInstead,
	isTakingOver,
	takeOverFailed = false,
}: {
	state: EntryLockState;
	onTakeOver: () => void;
	onReadInstead: () => void;
	isTakingOver: boolean;
	takeOverFailed?: boolean;
}) {
	const { t } = useLingui();
	const anotherEditor = t`Another editor`;
	const takeOverError = takeOverFailed ? t`Couldn’t take over this entry. Try again.` : null;

	if (state.status === "blocked") {
		const name = holderName(state.holder, anotherEditor);
		return (
			<LayerDialog.Alert
				open
				onOpenChange={(next) => {
					if (!next) onReadInstead();
				}}
				dismissDisabled={isTakingOver}
			>
				<LayerDialog.Content size="sm">
					<LayerDialog.Title>
						<span dir="auto" className="block">
							{t`This entry is open somewhere else`}
						</span>
					</LayerDialog.Title>
					<LayerDialog.Description>
						<span dir="auto" className="block">
							<Trans>
								<strong dir="auto">{name}</strong> is editing this entry. Open it read-only, or take
								over; they will be told the entry moved on.
							</Trans>
						</span>
					</LayerDialog.Description>
					<LayerDialog.Body>
						<DialogError message={takeOverError} />
					</LayerDialog.Body>
					<LayerDialog.Actions dismissLabel={t`Open read-only`}>
						<LayerDialog.Action disabled={isTakingOver} onClick={onTakeOver}>
							{isTakingOver ? t`Taking over...` : t`Take over`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				</LayerDialog.Content>
			</LayerDialog.Alert>
		);
	}

	if (state.status === "reading" || state.status === "taken") {
		const name = holderName(state.holder, anotherEditor);
		return (
			<div
				role="alert"
				className="rounded-lg border border-kumo-line bg-kumo-warning/10 p-4 text-start"
			>
				<p dir="auto" className="font-medium">
					{state.status === "taken" ? t`You no longer hold this entry` : t`Read-only`}
				</p>
				<p dir="auto" className="mt-1 text-sm text-kumo-subtle">
					{state.status === "taken" ? (
						<Trans>
							<strong dir="auto">{name}</strong> now holds this entry, so your changes are no longer
							being saved. Take it back to carry on.
						</Trans>
					) : (
						<Trans>
							<strong dir="auto">{name}</strong> is editing this entry. Nothing you change here will
							be saved.
						</Trans>
					)}
				</p>
				{takeOverError && (
					<p role="alert" dir="auto" className="mt-2 text-sm text-kumo-danger">
						{takeOverError}
					</p>
				)}
				<Button
					className="mt-3"
					size="sm"
					variant="secondary"
					disabled={isTakingOver}
					onClick={onTakeOver}
				>
					{isTakingOver ? t`Taking over...` : t`Take over`}
				</Button>
			</div>
		);
	}

	return null;
}
