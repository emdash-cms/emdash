import { Button, Dialog } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";

import type { EntryLockHolder } from "../lib/api/entry-lock.js";
import type { EntryLockState } from "../lib/useEntryLock.js";

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
}: {
	state: EntryLockState;
	onTakeOver: () => void;
	onReadInstead: () => void;
	isTakingOver: boolean;
}) {
	const { t } = useLingui();
	const anotherEditor = t`Another editor`;

	if (state.status === "blocked") {
		const name = holderName(state.holder, anotherEditor);
		return (
			<Dialog.Root
				role="alertdialog"
				open
				onOpenChange={(next) => {
					if (!next) onReadInstead();
				}}
			>
				<Dialog className="p-6" size="sm">
					<Dialog.Title dir="auto" className="text-lg font-semibold">
						{t`This entry is open somewhere else`}
					</Dialog.Title>
					<Dialog.Description dir="auto" className="text-kumo-subtle">
						<Trans>
							<strong dir="auto">{name}</strong> is editing this entry. Open it read-only, or take
							over; they will be told the entry moved on.
						</Trans>
					</Dialog.Description>
					<div className="mt-6 flex justify-end gap-2">
						<Button variant="secondary" onClick={onReadInstead}>
							{t`Open read-only`}
						</Button>
						<Button variant="primary" disabled={isTakingOver} onClick={onTakeOver}>
							{isTakingOver ? t`Taking over...` : t`Take over`}
						</Button>
					</div>
				</Dialog>
			</Dialog.Root>
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
