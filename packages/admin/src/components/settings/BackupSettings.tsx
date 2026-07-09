/**
 * Backup settings page
 *
 * One-click full backup download, scheduled backups to the site's storage
 * bucket with retention, the list of stored archives, and a pointer to
 * D1 Time Travel for point-in-time restore on Cloudflare.
 */

import { Button, Input, LinkButton, Loader, Switch, useKumoToastManager } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	Archive,
	ClockCounterClockwise,
	CloudArrowUp,
	DownloadSimple,
	Trash,
	WarningCircle,
} from "@phosphor-icons/react";
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
import { DialogError, getMutationError } from "../DialogError.js";
import { BackToSettingsLink } from "./BackToSettingsLink.js";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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

	// Local form state seeded from the server once loaded
	const [enabled, setEnabled] = React.useState(false);
	const [retention, setRetention] = React.useState("7");
	const seeded = React.useRef(false);
	React.useEffect(() => {
		if (overview && !seeded.current) {
			seeded.current = true;
			setEnabled(overview.settings.enabled);
			setRetention(String(overview.settings.retention));
		}
	}, [overview]);

	const saveMutation = useMutation({
		mutationFn: () => {
			// Clamp to the server's accepted range so out-of-range input saves
			// the nearest valid value instead of failing validation.
			const parsed = Number.parseInt(retention, 10);
			const clamped = Number.isNaN(parsed) ? 7 : Math.min(30, Math.max(1, parsed));
			return updateBackupSettings({ enabled, retention: clamped });
		},
		onSuccess: (settings) => {
			setEnabled(settings.enabled);
			setRetention(String(settings.retention));
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

	if (isLoading) {
		return (
			<div className="flex items-center justify-center py-12">
				<Loader size="lg" />
			</div>
		);
	}

	if (fetchError) {
		return (
			<div className="space-y-6">
				<div className="flex items-center gap-3">
					<BackToSettingsLink />
					<h1 className="text-2xl font-bold">{t`Backups`}</h1>
				</div>
				<DialogError message={getMutationError(fetchError) || t`Failed to load backup settings`} />
			</div>
		);
	}

	const storageAvailable = overview?.storageAvailable ?? false;
	const archives = overview?.archives ?? [];

	return (
		<div className="space-y-6">
			{/* Header */}
			<div className="flex items-center gap-3">
				<BackToSettingsLink />
				<h1 className="text-2xl font-bold">{t`Backups`}</h1>
			</div>

			{/* One-click download */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<DownloadSimple className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Download Backup`}</h2>
				</div>
				<p className="text-sm text-kumo-subtle mb-4">
					{t`Download a complete backup of your site: all content (including drafts and trash), collections, taxonomies, menus, widgets, media metadata, and site settings. User accounts and secrets are never included.`}
				</p>
				<LinkButton href={BACKUP_EXPORT_URL}>{t`Download backup`}</LinkButton>
			</div>

			{/* Scheduled backups */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-4">
					<CloudArrowUp className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Automatic Backups`}</h2>
				</div>

				{storageAvailable ? (
					<div className="space-y-4">
						<p className="text-sm text-kumo-subtle">
							{t`Store a daily backup in your site's storage bucket. Old backups are removed automatically.`}
						</p>
						<Switch
							label={t`Daily automatic backups`}
							checked={enabled}
							onCheckedChange={setEnabled}
						/>
						<div className="max-w-48">
							<Input
								label={t`Backups to keep`}
								type="number"
								min={1}
								max={30}
								value={retention}
								onChange={(e) => setRetention(e.target.value)}
							/>
						</div>
						<div className="flex items-center gap-3">
							<Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
								{saveMutation.isPending ? t`Saving...` : t`Save`}
							</Button>
							<Button
								variant="secondary"
								onClick={() => backupNowMutation.mutate()}
								disabled={backupNowMutation.isPending}
							>
								{backupNowMutation.isPending ? t`Backing up...` : t`Back up now`}
							</Button>
						</div>
					</div>
				) : (
					<div className="flex items-start gap-3 rounded-lg border border-kumo-warning/50 bg-kumo-warning-tint p-4">
						<WarningCircle className="h-5 w-5 text-kumo-warning mt-0.5 flex-shrink-0" />
						<p className="text-sm">
							{t`Automatic backups need a storage backend (R2, S3, or local storage). Configure storage in your EmDash config to enable them.`}
						</p>
					</div>
				)}
			</div>

			{/* Stored archives */}
			{storageAvailable && archives.length > 0 && (
				<div className="rounded-lg border bg-kumo-base p-6">
					<div className="flex items-center gap-2 mb-4">
						<Archive className="h-5 w-5 text-kumo-subtle" />
						<h2 className="text-lg font-semibold">{t`Stored Backups`}</h2>
					</div>
					<ul className="divide-y">
						{archives.map((archive) => (
							<li key={archive.name} className="flex items-center justify-between gap-3 py-3">
								<div className="min-w-0">
									<div className="font-mono text-sm truncate">{archive.name}</div>
									<div className="text-sm text-kumo-subtle">
										{i18n.date(new Date(archive.lastModified), {
											dateStyle: "medium",
											timeStyle: "short",
										})}{" "}
										· {formatBytes(archive.size)}
									</div>
								</div>
								<div className="flex items-center gap-2 flex-shrink-0">
									<LinkButton
										variant="secondary"
										size="sm"
										href={backupArchiveUrl(archive.name)}
										aria-label={t`Download ${archive.name}`}
									>
										<DownloadSimple className="h-4 w-4" />
									</LinkButton>
									<Button
										variant="secondary"
										size="sm"
										aria-label={t`Delete ${archive.name}`}
										onClick={() => {
											deleteMutation.reset();
											setArchiveToDelete(archive);
										}}
									>
										<Trash className="h-4 w-4" />
									</Button>
								</div>
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Time Travel hint */}
			<div className="rounded-lg border bg-kumo-base p-6">
				<div className="flex items-center gap-2 mb-2">
					<ClockCounterClockwise className="h-5 w-5 text-kumo-subtle" />
					<h2 className="text-lg font-semibold">{t`Point-in-Time Restore`}</h2>
				</div>
				<p className="text-sm text-kumo-subtle">
					{t`Sites on Cloudflare D1 can additionally restore the database to any minute within the last 30 days using D1 Time Travel — always on, no setup required.`}{" "}
					<a
						className="underline"
						href="https://developers.cloudflare.com/d1/reference/time-travel/"
						target="_blank"
						rel="noreferrer"
					>
						{t`Learn more`}
					</a>
				</p>
			</div>

			<ConfirmDialog
				open={archiveToDelete !== null}
				onClose={() => setArchiveToDelete(null)}
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
		</div>
	);
}
