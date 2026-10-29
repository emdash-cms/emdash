import { Button, Input, LayerDialog, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";

import { ApiResponseError, type MediaFolder } from "../lib/api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DialogError, getMutationError } from "./DialogError.js";

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
	const [validationError, setValidationError] = React.useState<string | null>(null);
	const [deleteOpen, setDeleteOpen] = React.useState(false);
	const deleteButtonRef = React.useRef<HTMLButtonElement>(null);
	const formId = React.useId();
	const savePendingRef = React.useRef(false);
	const deletePendingRef = React.useRef(false);
	const isEditing = folder !== null && folder !== undefined;

	React.useEffect(() => {
		if (!open) return;
		setName(folder?.name ?? "");
		setValidationError(null);
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
	const mutationError = saveMutation.error;
	const fieldError =
		mutationError instanceof ApiResponseError
			? mutationError.code === "VALIDATION_ERROR"
				? t`Folder name must be between 1 and 200 characters`
				: mutationError.code === "CONFLICT"
					? t`A media folder with this name already exists`
					: null
			: null;
	const dialogError = fieldError ? null : getMutationError(mutationError);

	const submit = (event: React.FormEvent) => {
		event.preventDefault();
		if (isPending || savePendingRef.current) return;
		const trimmed = name.trim();
		if (trimmed.length < 1 || trimmed.length > 200) {
			setValidationError(t`Folder name must be between 1 and 200 characters`);
			return;
		}
		setValidationError(null);
		savePendingRef.current = true;
		saveMutation.mutate(trimmed);
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
				onOpenChange={(nextOpen) => {
					if (!nextOpen && !isPending && !deleteOpen) onClose();
				}}
				dismissDisabled={isPending}
			>
				<LayerDialog.Content size="sm">
					<LayerDialog.Title>{isEditing ? t`Edit folder` : t`Add new folder`}</LayerDialog.Title>
					<LayerDialog.Body>
						<form id={formId} onSubmit={submit} noValidate>
							<Input
								label={t`Name`}
								value={name}
								onChange={(event) => {
									setName(event.target.value);
									setValidationError(null);
									saveMutation.reset();
								}}
								error={validationError ?? fieldError ?? undefined}
								autoFocus
								disabled={isPending}
							/>
							<DialogError message={dialogError} className="mt-3" />
							{folder && (
								<div className="mt-6 border-t border-kumo-line pt-5">
									<Button
										ref={deleteButtonRef}
										variant="secondary-destructive"
										type="button"
										onClick={() => {
											deleteMutation.reset();
											setDeleteOpen(true);
										}}
										disabled={isPending}
									>
										{t`Delete folder`}
									</Button>
								</div>
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
