/**
 * PasskeyItem - Individual passkey display with rename and delete actions
 */

import { Button, Input } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Pencil, Trash, Check, X, DeviceMobile, Cloud } from "@phosphor-icons/react";
import * as React from "react";

import type { PasskeyInfo } from "../../lib/api";
import { ConfirmDialog } from "../ConfirmDialog.js";

export interface PasskeyItemProps {
	passkey: PasskeyInfo;
	canDelete: boolean;
	onRename: (id: string, name: string) => Promise<void>;
	onDelete: (id: string) => Promise<void>;
	isDeleting?: boolean;
	isRenaming?: boolean;
}

function formatRelativeTime(dateString: string, locale: string): string {
	const date = new Date(dateString);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffSecs = Math.floor(diffMs / 1000);
	const diffMins = Math.floor(diffSecs / 60);
	const diffHours = Math.floor(diffMins / 60);
	const diffDays = Math.floor(diffHours / 24);

	const relativeTime = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (diffSecs < 60) return relativeTime.format(0, "second");
	if (diffMins < 60) return relativeTime.format(-diffMins, "minute");
	if (diffHours < 24) return relativeTime.format(-diffHours, "hour");
	if (diffDays < 7) return relativeTime.format(-diffDays, "day");
	return date.toLocaleDateString(locale, {
		month: "short",
		day: "numeric",
		year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
	});
}

export function PasskeyItem({
	passkey,
	canDelete,
	onRename,
	onDelete,
	isDeleting,
	isRenaming,
}: PasskeyItemProps) {
	const { t, i18n } = useLingui();
	const [isEditing, setIsEditing] = React.useState(false);
	const [editName, setEditName] = React.useState(passkey.name || "");
	const [showDeleteDialog, setShowDeleteDialog] = React.useState(false);
	const [deleteError, setDeleteError] = React.useState<string | null>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);

	React.useEffect(() => {
		if (isEditing && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isEditing]);

	const handleSave = async () => {
		try {
			await onRename(passkey.id, editName.trim());
			setIsEditing(false);
		} catch {
			// Error handled by parent
		}
	};

	const handleCancel = () => {
		setEditName(passkey.name || "");
		setIsEditing(false);
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter") {
			void handleSave();
		} else if (e.key === "Escape") {
			handleCancel();
		}
	};

	const handleDelete = async () => {
		try {
			setDeleteError(null);
			await onDelete(passkey.id);
			setShowDeleteDialog(false);
		} catch (err) {
			setDeleteError(err instanceof Error ? err.message : t`Failed to remove passkey`);
		}
	};

	const deviceTypeLabel =
		passkey.deviceType === "multiDevice" ? t`Synced passkey` : t`Device-bound passkey`;

	return (
		<li className="flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex min-w-0 items-start gap-3">
				{/* Icon */}
				<div className="mt-0.5 p-2 rounded-md bg-kumo-tint">
					{passkey.deviceType === "multiDevice" ? (
						<Cloud className="h-4 w-4 text-kumo-subtle" />
					) : (
						<DeviceMobile className="h-4 w-4 text-kumo-subtle" />
					)}
				</div>

				{/* Info */}
				<div className="min-w-0 flex-1">
					{isEditing ? (
						<div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center">
							<Input
								ref={inputRef}
								type="text"
								value={editName}
								onChange={(e) => setEditName(e.target.value)}
								onKeyDown={handleKeyDown}
								className="h-8 w-full sm:w-48"
								placeholder={t`Passkey name`}
								aria-label={t`Passkey name`}
								disabled={isRenaming}
							/>
							<Button
								size="sm"
								variant="ghost"
								onClick={handleSave}
								disabled={isRenaming}
								aria-label={t`Save name`}
							>
								<Check className="h-4 w-4" />
							</Button>
							<Button
								size="sm"
								variant="ghost"
								onClick={handleCancel}
								disabled={isRenaming}
								aria-label={t`Cancel rename`}
							>
								<X className="h-4 w-4" />
							</Button>
						</div>
					) : (
						<div className="font-medium">{passkey.name || t`Unnamed passkey`}</div>
					)}
					<div className="text-sm text-kumo-subtle">
						{deviceTypeLabel}
						{passkey.backedUp && <span className="text-kumo-success"> {t`(synced)`}</span>}
					</div>
					<div className="text-xs text-kumo-subtle mt-1">
						{t`Last used`} {formatRelativeTime(passkey.lastUsedAt, i18n.locale)}
					</div>
				</div>
			</div>

			{/* Actions */}
			{!isEditing && (
				<div className="flex self-end items-center gap-1 sm:self-center">
					<Button
						variant="ghost"
						size="sm"
						onClick={() => {
							setEditName(passkey.name || "");
							setIsEditing(true);
						}}
						title={t`Rename`}
						aria-label={passkey.name ? t`Rename ${passkey.name}` : t`Rename passkey`}
					>
						<Pencil className="h-4 w-4" />
					</Button>
					{canDelete && (
						<Button
							variant="ghost"
							size="sm"
							onClick={() => setShowDeleteDialog(true)}
							className="text-kumo-danger hover:text-kumo-danger"
							title={t`Remove`}
							aria-label={passkey.name ? t`Remove ${passkey.name}` : t`Remove passkey`}
						>
							<Trash className="h-4 w-4" />
						</Button>
					)}
				</div>
			)}

			{/* Delete confirmation dialog */}
			<ConfirmDialog
				open={showDeleteDialog}
				onClose={() => {
					setShowDeleteDialog(false);
					setDeleteError(null);
				}}
				title={t`Remove passkey?`}
				description={
					passkey.name
						? t`You won't be able to use "${passkey.name}" to sign in anymore. This action cannot be undone.`
						: t`You won't be able to use this passkey to sign in anymore. This action cannot be undone.`
				}
				confirmLabel={t`Remove`}
				pendingLabel={t`Removing...`}
				isPending={!!isDeleting}
				error={deleteError}
				onConfirm={handleDelete}
			/>
		</li>
	);
}
