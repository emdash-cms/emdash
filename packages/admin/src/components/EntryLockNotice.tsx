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
 * that keeps explaining it once the editor has answered. While a co-editing
 * room holds the entry, **Take over** becomes **Join**, which `onTakeOver`
 * runs as well.
 */
export function EntryLockNotice({
	state,
	onTakeOver,
	onReadInstead,
	isTakingOver,
	takeOverFailed = false,
	canJoin = true,
}: {
	state: EntryLockState;
	onTakeOver: () => void;
	onReadInstead: () => void;
	isTakingOver: boolean;
	takeOverFailed?: boolean;
	/** False once this browser session can only open entries in single-editor mode. */
	canJoin?: boolean;
}) {
	const { t } = useLingui();
	const anotherEditor = t`Another editor`;

	if ("room" in state && state.room) {
		return (
			<RoomLockNotice
				state={state}
				onJoin={canJoin ? onTakeOver : undefined}
				onReadInstead={onReadInstead}
				isJoining={isTakingOver}
				joinFailed={takeOverFailed}
			/>
		);
	}

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

/** The lock notice while people edit the entry together in a room. */
function RoomLockNotice({
	state,
	onJoin,
	onReadInstead,
	isJoining,
	joinFailed,
}: {
	state: Extract<EntryLockState, { status: "blocked" | "reading" | "taken" }>;
	onJoin: (() => void) | undefined;
	onReadInstead: () => void;
	isJoining: boolean;
	joinFailed: boolean;
}) {
	const { t } = useLingui();
	const joinError = joinFailed ? t`Couldn’t join. Try again.` : null;
	const joinLabel = isJoining ? t`Joining...` : t`Join`;

	if (state.status === "blocked" && onJoin) {
		return (
			<LayerDialog.Alert
				open
				onOpenChange={(next) => {
					if (!next) onReadInstead();
				}}
				dismissDisabled={isJoining}
			>
				<LayerDialog.Content size="sm">
					<LayerDialog.Title>
						<span dir="auto" className="block">
							{t`People are editing this entry together`}
						</span>
					</LayerDialog.Title>
					<LayerDialog.Description>
						<span dir="auto" className="block">
							{t`Join them to edit it together, or open it read-only.`}
						</span>
					</LayerDialog.Description>
					<LayerDialog.Body>
						<DialogError message={joinError} />
					</LayerDialog.Body>
					<LayerDialog.Actions dismissLabel={t`Open read-only`}>
						<LayerDialog.Action disabled={isJoining} onClick={onJoin}>
							{joinLabel}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				</LayerDialog.Content>
			</LayerDialog.Alert>
		);
	}

	return (
		<div
			role="alert"
			className="rounded-lg border border-kumo-line bg-kumo-warning/10 p-4 text-start"
		>
			<p dir="auto" className="font-medium">
				{t`People are editing this entry together`}
			</p>
			<p dir="auto" className="mt-1 text-sm text-kumo-subtle">
				{state.status === "taken"
					? onJoin
						? t`Your changes are no longer being saved. Join them to carry on.`
						: t`Your changes are no longer being saved.`
					: onJoin
						? t`Nothing you change here will be saved.`
						: t`This browser can’t join them, so nothing you change here will be saved.`}
			</p>
			{joinError && (
				<p role="alert" dir="auto" className="mt-2 text-sm text-kumo-danger">
					{joinError}
				</p>
			)}
			{onJoin && (
				<Button
					className="mt-3"
					size="sm"
					variant="secondary"
					type="button"
					disabled={isJoining}
					onClick={onJoin}
				>
					{joinLabel}
				</Button>
			)}
		</div>
	);
}
