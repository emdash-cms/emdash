import { useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { restoreRevision, type ContentItem, type RevisionListItem } from "../../lib/api";
import { isolate } from "../../lib/utils.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { getMutationError } from "../DialogError.js";
import { revisionDate, useRevisionFormat } from "./revision-format.js";

export interface RevisionRestoreDialogProps {
	open: boolean;
	onClose: () => void;
	collection: string;
	entryId: string;
	revision: RevisionListItem;
	/** The entry has a draft, which the restored version replaces. */
	hasDraft: boolean;
	/** The entry is scheduled, so the restored version publishes on its own at that time. */
	scheduled: boolean;
	/** The editor holds edits that restoring would replace. */
	isDirty: boolean;
	/** The server restored the version and the editor is loading it. */
	restorePending: boolean;
	onRestoreStart: (restoredItem: ContentItem) => void;
	onRestoreFailed: () => void;
	/** Closes the view when nothing reloads the editor. */
	onRestoreSettled: () => void;
	/** Reloads the editor with the restored draft. */
	onRevisionRestored?: (item: ContentItem) => void | Promise<void>;
}

export function RevisionRestoreDialog({
	open,
	onClose,
	collection,
	entryId,
	revision,
	hasDraft,
	scheduled,
	isDirty,
	restorePending,
	onRestoreStart,
	onRestoreFailed,
	onRestoreSettled,
	onRevisionRestored,
}: RevisionRestoreDialogProps) {
	const { t } = useLingui();
	const format = useRevisionFormat();
	const queryClient = useQueryClient();
	const toastManager = useKumoToastManager();
	const when = isolate(format.when(revisionDate(revision.createdAt)));
	const shownRef = React.useRef(false);
	React.useEffect(() => {
		shownRef.current = open;
		return () => {
			shownRef.current = false;
		};
	}, [open]);

	const restore = useMutation({
		mutationFn: (revisionId: string) => restoreRevision(revisionId),
		onSuccess: async (restoredItem) => {
			onRestoreStart(restoredItem);
			void queryClient.invalidateQueries({ queryKey: ["content", collection, entryId] });
			void queryClient.invalidateQueries({ queryKey: ["revisions", collection, entryId] });
			if (onRevisionRestored) {
				try {
					await onRevisionRestored(restoredItem);
				} catch (error) {
					onRestoreFailed();
					throw error;
				}
			} else {
				onRestoreSettled();
			}
			onClose();
			toastManager.add({
				title: t`Version restored`,
				description: scheduled
					? t`The version from ${when} is now your draft. It goes live at the scheduled time.`
					: t`The version from ${when} is now your draft. Publish when you're ready.`,
				variant: "success",
			});
		},
		onError: (error) => {
			// The dialog shows the error itself while it is open.
			if (shownRef.current) return;
			toastManager.add({
				title: t`Restore failed`,
				description: getMutationError(error) ?? undefined,
				variant: "error",
			});
		},
	});

	const resetRestore = restore.reset;
	React.useEffect(() => {
		if (open) resetRestore();
	}, [open, resetRestore]);

	return (
		<ConfirmDialog
			open={open}
			onClose={onClose}
			compact
			variant="primary"
			title={t`Restore this version?`}
			description={
				<>
					{hasDraft
						? scheduled
							? t`Your draft will be replaced with the version from ${when}. Your current draft stays in Revisions, and the restored version goes live at the scheduled time.`
							: t`Your draft will be replaced with the version from ${when}. Your current draft stays in Revisions, and the live site won't change until you publish.`
						: scheduled
							? t`The version from ${when} becomes your draft and goes live at the scheduled time.`
							: t`The version from ${when} becomes your draft. The live site won't change until you publish.`}
					{isDirty && (
						<>
							{" "}
							<span className="mt-2 block font-medium text-kumo-default">
								{t`Your unsaved changes will be lost.`}
							</span>
						</>
					)}
				</>
			}
			confirmLabel={t`Restore`}
			pendingLabel={t`Restoring…`}
			isPending={restore.isPending || restorePending}
			preventCloseWhilePending
			error={restore.error}
			onConfirm={() => restore.mutate(revision.id)}
		/>
	);
}
