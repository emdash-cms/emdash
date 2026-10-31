import { Button, Input, LayerDialog, useKumoToastManager } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { ApiResponseError, type MediaFolder } from "../lib/api";
import { guardUnsavedInput, revealErrors } from "../lib/dialog-form.js";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogError, getMutationError } from "./DialogError.js";
import { DialogSection } from "./DialogSection.js";

const FOLDER_NAME_MAX_LENGTH = 200;

/** Folder names that differ only in case or Unicode form count as the same name. */
function folderNameKey(name: string): string {
	return name.trim().normalize("NFKC").toLowerCase();
}

function nameProblem(name: string): MessageDescriptor | undefined {
	const length = name.trim().length;
	if (length < 1) return msg`Enter a folder name.`;
	if (length > FOLDER_NAME_MAX_LENGTH) return msg`Use 200 characters or fewer.`;
	return undefined;
}

export interface MediaFolderDialogProps {
	open: boolean;
	folder?: MediaFolder | null;
	onClose: () => void;
	onCreate: (name: string) => Promise<MediaFolder>;
	onRename: (folder: MediaFolder, name: string) => Promise<MediaFolder>;
	onDelete: (folder: MediaFolder) => Promise<void>;
}

export function MediaFolderDialog({
	open,
	folder,
	onClose,
	onCreate,
	onRename,
	onDelete,
}: MediaFolderDialogProps) {
	const { t } = useLingui();
	const toastManager = useKumoToastManager();
	const [name, setName] = React.useState("");
	const [submitted, setSubmitted] = React.useState(false);
	const [takenName, setTakenName] = React.useState<string | null>(null);
	const [deleteOpen, setDeleteOpen] = React.useState(false);
	const deleteButtonRef = React.useRef<HTMLButtonElement>(null);
	const formRef = React.useRef<HTMLFormElement>(null);
	const formId = React.useId();
	const savePendingRef = React.useRef(false);
	const deletePendingRef = React.useRef(false);
	const isEditing = folder !== null && folder !== undefined;

	React.useEffect(() => {
		if (!open) return;
		setName(folder?.name ?? "");
		setSubmitted(false);
		setTakenName(null);
		setDeleteOpen(false);
		savePendingRef.current = false;
		deletePendingRef.current = false;
	}, [folder?.id, folder?.name, open]);

	const saveMutation = useMutation({
		mutationFn: (nextName: string) => (folder ? onRename(folder, nextName) : onCreate(nextName)),
		onSuccess: () => {
			toastManager.add({
				title: isEditing ? t`Folder successfully edited` : t`Folder successfully created`,
				variant: "success",
				timeout: 3000,
			});
			onClose();
		},
		onSettled: () => {
			savePendingRef.current = false;
		},
	});
	const deleteMutation = useMutation({
		mutationFn: () => {
			if (!folder) throw new Error(t`Folder unavailable`);
			return onDelete(folder);
		},
		onSuccess: () => {
			setDeleteOpen(false);
			toastManager.add({ title: t`Folder deleted`, variant: "success", timeout: 3000 });
			onClose();
		},
		onSettled: () => {
			deletePendingRef.current = false;
		},
	});
	React.useEffect(() => {
		if (!open) return;
		saveMutation.reset();
		deleteMutation.reset();
	}, [folder?.id, open]);
	const isPending = saveMutation.isPending || deleteMutation.isPending;
	const unsaved = name !== (folder?.name ?? "");
	const problem =
		takenName !== null && folderNameKey(name) === folderNameKey(takenName)
			? msg`Another folder already uses this name. Enter a different one.`
			: nameProblem(name);
	const nameError = submitted && problem ? t(problem) : undefined;
	const saveError = saveMutation.error;
	const dialogError =
		saveError instanceof ApiResponseError && saveError.code === "CONFLICT"
			? null
			: getMutationError(saveError);

	const showErrors = (update?: () => void) => {
		revealErrors(formRef.current, () => {
			setSubmitted(true);
			update?.();
		});
	};

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		if (isPending || savePendingRef.current) return;
		if (problem) {
			showErrors();
			return;
		}
		const trimmed = name.trim();
		savePendingRef.current = true;
		saveMutation.mutate(trimmed, {
			onError: (error) => {
				if (error instanceof ApiResponseError && error.code === "CONFLICT") {
					showErrors(() => setTakenName(trimmed));
				}
			},
		});
	};
	const closeDelete = () => {
		if (deleteMutation.isPending) return;
		setDeleteOpen(false);
		deleteMutation.reset();
		window.requestAnimationFrame(() => deleteButtonRef.current?.focus());
	};
	const confirmDelete = () => {
		if (deletePendingRef.current || deleteMutation.isPending) return;
		deletePendingRef.current = true;
		deleteMutation.mutate();
	};

	return (
		<>
			<LayerDialog.Root
				open={open}
				{...guardUnsavedInput(unsaved, (nextOpen) => {
					if (!nextOpen && !isPending && !deleteOpen) onClose();
				})}
				dismissDisabled={isPending}
			>
				<LayerDialog.Content size="sm">
					<LayerDialog.Title>{isEditing ? t`Edit folder` : t`Add new folder`}</LayerDialog.Title>
					<LayerDialog.Body>
						<form ref={formRef} id={formId} onSubmit={submit} noValidate className="grid gap-5">
							<Input
								label={t`Name`}
								value={name}
								onChange={(event) => {
									setName(event.target.value);
									saveMutation.reset();
								}}
								error={nameError}
								aria-invalid={nameError ? true : undefined}
								required
								autoFocus
								disabled={isPending}
							/>
							<DialogError message={dialogError} />
							{folder && (
								<DialogSection
									title={t`Delete folder`}
									description={t`Media in this folder will return to Main library. No files will be deleted.`}
									action={
										<Button
											ref={deleteButtonRef}
											variant="secondary-destructive"
											type="button"
											aria-label={t`Delete folder`}
											onClick={() => {
												deleteMutation.reset();
												setDeleteOpen(true);
											}}
											disabled={isPending}
										>
											{t`Delete`}
										</Button>
									}
								/>
							)}
						</form>
					</LayerDialog.Body>
					<LayerDialog.Actions dismissLabel={t`Cancel`}>
						<LayerDialog.Action type="submit" form={formId} disabled={isPending}>
							{saveMutation.isPending ? t`Saving...` : isEditing ? t`Save` : t`Create`}
						</LayerDialog.Action>
					</LayerDialog.Actions>
				</LayerDialog.Content>
			</LayerDialog.Root>
			{folder && (
				<ConfirmDialog
					open={deleteOpen}
					onClose={closeDelete}
					title={t`Delete “${folder.name}”?`}
					description={t`Media in this folder will return to Main library. No files will be deleted.`}
					confirmLabel={t`Delete folder`}
					pendingLabel={t`Deleting...`}
					isPending={deleteMutation.isPending}
					error={deleteMutation.error}
					onConfirm={confirmDelete}
				/>
			)}
		</>
	);
}
