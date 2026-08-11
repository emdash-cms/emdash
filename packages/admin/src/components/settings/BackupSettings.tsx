/**
 * Backup settings page
 *
 * One-click full backup download, scheduled backups to the site's storage
 * bucket with retention, the list of stored archives, and a pointer to
 * D1 Time Travel for point-in-time restore on Cloudflare.
 */

import {
	Banner,
	Button,
	Input,
	LinkButton,
	Loader,
	Switch,
	useKumoToastManager,
} from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { DownloadSimple, Trash } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	backupArchiveUrl,
	BACKUP_EXPORT_URL,
	createBackupArchive,
	deleteBackupArchive,
	fetchBackupOverview,
	updateBackupSettings,
	type BackupArchive,
} from "../../lib/api/backups.js";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { getMutationError } from "../DialogError.js";
import { SaveButton } from "../SaveButton.js";
import { SettingRow, SettingsFrame, SettingsSection } from "./SettingsLayout.js";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function backupSettingsSnapshot(enabled: boolean, retention: string) {
	return JSON.stringify({ enabled, retention });
}

export function BackupSettings() {
	const { t, i18n } = useLingui();
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();
	const [archiveToDelete, setArchiveToDelete] = React.useState<BackupArchive | null>(null);

	const {
		data: overview,
		isLoading,
		error: fetchError,
	} = useQuery({
		queryKey: ["backup-overview"],
		queryFn: fetchBackupOverview,
	});

	const [enabled, setEnabled] = React.useState(false);
	const [retention, setRetention] = React.useState("7");
	const [savedEnabled, setSavedEnabled] = React.useState(false);
	const [savedRetention, setSavedRetention] = React.useState("7");
	const seeded = React.useRef(false);
	React.useEffect(() => {
		if (overview && !seeded.current) {
			seeded.current = true;
			const loadedRetention = String(overview.settings.retention);
			setEnabled(overview.settings.enabled);
			setRetention(loadedRetention);
			setSavedEnabled(overview.settings.enabled);
			setSavedRetention(loadedRetention);
		}
	}, [overview]);

	const isDirty = React.useMemo(
		() =>
			backupSettingsSnapshot(enabled, retention) !==
			backupSettingsSnapshot(savedEnabled, savedRetention),
		[enabled, retention, savedEnabled, savedRetention],
	);

	const saveMutation = useMutation({
		mutationFn: () => {
			const parsed = Number.parseInt(retention, 10);
			const clamped = Number.isNaN(parsed) ? 7 : Math.min(30, Math.max(1, parsed));
			return updateBackupSettings({ enabled, retention: clamped });
		},
		onSuccess: (settings) => {
			const savedRetentionValue = String(settings.retention);
			setEnabled(settings.enabled);
			setRetention(savedRetentionValue);
			setSavedEnabled(settings.enabled);
			setSavedRetention(savedRetentionValue);
			void queryClient.invalidateQueries({ queryKey: ["backup-overview"] });
			toastManager.add({ title: t`Backup settings saved`, variant: "success", timeout: 4000 });
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to save backup settings`,
				description: getMutationError(error) || t`An error occurred`,
				variant: "error",
				timeout: 5000,
			});
		},
	});

	const backupNowMutation = useMutation({
		mutationFn: createBackupArchive,
		onSuccess: (archive) => {
			void queryClient.invalidateQueries({ queryKey: ["backup-overview"] });
			toastManager.add({
				title: t`Backup created: ${archive.name}`,
				variant: "success",
				timeout: 4000,
			});
		},
		onError: (error) => {
			toastManager.add({
				title: t`Failed to create backup`,
				description: getMutationError(error) || t`An error occurred`,
				variant: "error",
				timeout: 5000,
			});
		},
	});

	const deleteMutation = useMutation({
		mutationFn: (name: string) => deleteBackupArchive(name),
		onSuccess: () => {
			setArchiveToDelete(null);
			void queryClient.invalidateQueries({ queryKey: ["backup-overview"] });
		},
	});

	const handleSave = (event: React.FormEvent) => {
		event.preventDefault();
		saveMutation.mutate();
	};

	const title = t`Backups`;
	const description = t`Download backups and schedule automatic backups to storage`;

	if (isLoading) {
		return (
			<SettingsFrame title={title} description={description}>
				<div
					className="flex items-center gap-2 rounded-xl border border-kumo-line bg-kumo-base px-4 py-4 text-sm text-kumo-subtle"
					role="status"
				>
					<Loader size="sm" />
					<span>{t`Loading...`}</span>
				</div>
			</SettingsFrame>
		);
	}

	if (fetchError) {
		return (
			<SettingsFrame title={title} description={description}>
				<Banner
					variant="error"
					title={t`Failed to load backup settings`}
					description={getMutationError(fetchError) || t`An error occurred`}
					role="alert"
				/>
			</SettingsFrame>
		);
	}

	const storageAvailable = overview?.storageAvailable ?? false;
	const archives = overview?.archives ?? [];
	const saveAction = storageAvailable ? (
		<SaveButton
			type="submit"
			form="automatic-backups-form"
			isDirty={isDirty}
			isSaving={saveMutation.isPending}
		/>
	) : undefined;

	return (
		<SettingsFrame title={title} description={description} actions={saveAction}>
			<div className="grid gap-8">
				<SettingsSection title={t`Download Backup`}>
					<SettingRow>
						<div className="grid gap-4 sm:grid-cols-2 sm:items-center">
							<p className="text-sm leading-5 text-pretty text-kumo-subtle">
								{t`Download a complete backup of your site: all content (including drafts and trash), collections, taxonomies, menus, widgets, media metadata, and site settings. User accounts and secrets are never included.`}
							</p>
							<div className="flex justify-end">
								<LinkButton href={BACKUP_EXPORT_URL} variant="outline" icon={<DownloadSimple />}>
									{t`Download backup`}
								</LinkButton>
							</div>
						</div>
					</SettingRow>
				</SettingsSection>

				<form id="automatic-backups-form" onSubmit={handleSave} noValidate>
					<SettingsSection
						title={t`Automatic Backups`}
						description={t`Store a daily backup in your site's storage bucket. Old backups are removed automatically.`}
						actions={
							storageAvailable ? (
								<Button
									type="button"
									variant="outline"
									onClick={() => backupNowMutation.mutate()}
									disabled={backupNowMutation.isPending}
								>
									{backupNowMutation.isPending ? t`Backing up...` : t`Back up now`}
								</Button>
							) : undefined
						}
					>
						{storageAvailable ? (
							<>
								<SettingRow>
									<Switch
										label={t`Daily automatic backups`}
										controlFirst={false}
										className="ms-auto"
										checked={enabled}
										onCheckedChange={setEnabled}
									/>
								</SettingRow>
								<SettingRow>
									<div className="grid gap-4 sm:grid-cols-2 sm:items-center">
										<div className="grid gap-1">
											<label
												id="backup-retention-label"
												htmlFor="backup-retention"
												className="text-sm font-medium"
											>
												{t`Backups to keep`}
											</label>
										</div>
										<div className="flex justify-end">
											<Input
												id="backup-retention"
												aria-labelledby="backup-retention-label"
												className="w-full max-w-48"
												type="number"
												min={1}
												max={30}
												value={retention}
												onChange={(event) => setRetention(event.target.value)}
											/>
										</div>
									</div>
								</SettingRow>
							</>
						) : (
							<SettingRow>
								<Banner
									variant="alert"
									title={t`Automatic Backups`}
									description={t`Automatic backups need a storage backend (R2, S3, or local storage). Configure storage in your EmDash config to enable them.`}
									role="status"
								/>
							</SettingRow>
						)}
					</SettingsSection>
				</form>

				<SettingsSection
					title={t`Stored Backups`}
					contentClassName={
						storageAvailable && archives.length === 0
							? "border-2 border-dashed border-kumo-subtle/60"
							: undefined
					}
				>
					{!storageAvailable ? (
						<SettingRow className="py-8 text-center text-sm text-kumo-subtle">
							{t`Automatic backups need a storage backend (R2, S3, or local storage). Configure storage in your EmDash config to enable them.`}
						</SettingRow>
					) : archives.length === 0 ? (
						<SettingRow className="py-8 text-center text-sm text-kumo-subtle">
							{t`No items yet`}
						</SettingRow>
					) : (
						archives.map((archive) => (
							<SettingRow key={archive.name}>
								<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
									<div className="min-w-0 text-sm">
										<div className="break-all font-mono text-[0.9em] leading-5">{archive.name}</div>
										<div className="leading-5 text-kumo-subtle">
											{i18n.date(new Date(archive.lastModified), {
												dateStyle: "medium",
												timeStyle: "short",
											})}{" "}
											· {formatBytes(archive.size)}
										</div>
									</div>
									<div className="flex shrink-0 self-end items-center gap-2 sm:self-center">
										<LinkButton
											variant="outline"
											size="sm"
											href={backupArchiveUrl(archive.name)}
											aria-label={t`Download ${archive.name}`}
										>
											<DownloadSimple className="h-4 w-4" />
										</LinkButton>
										<Button
											type="button"
											variant="outline"
											size="sm"
											aria-label={t`Delete ${archive.name}`}
											onClick={() => {
												deleteMutation.reset();
												setArchiveToDelete(archive);
											}}
										>
											<Trash className="h-4 w-4 text-kumo-danger" />
										</Button>
									</div>
								</div>
							</SettingRow>
						))
					)}
				</SettingsSection>

				<SettingsSection title={t`Point-in-Time Restore`}>
					<SettingRow>
						<p className="max-w-2xl text-sm leading-5 text-kumo-subtle">
							{t`Sites on Cloudflare D1 can additionally restore the database to any minute within the last 30 days using D1 Time Travel — always on, no setup required.`}{" "}
							<a
								className="font-medium text-kumo-link underline underline-offset-2"
								href="https://developers.cloudflare.com/d1/reference/time-travel/"
								target="_blank"
								rel="noreferrer"
							>
								{t`Learn more`}
							</a>
						</p>
					</SettingRow>
				</SettingsSection>
			</div>

			<ConfirmDialog
				open={archiveToDelete !== null}
				onClose={() => {
					setArchiveToDelete(null);
					deleteMutation.reset();
				}}
				title={t`Delete backup?`}
				description={t`This permanently deletes ${archiveToDelete?.name ?? ""} from storage.`}
				confirmLabel={t`Delete`}
				pendingLabel={t`Deleting...`}
				isPending={deleteMutation.isPending}
				error={deleteMutation.error}
				onConfirm={() => {
					if (archiveToDelete) deleteMutation.mutate(archiveToDelete.name);
				}}
			/>
		</SettingsFrame>
	);
}
