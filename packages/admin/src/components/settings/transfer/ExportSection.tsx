import { Badge, Banner, Button, LinkButton, Loader, Meter, Switch } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { DownloadSimple } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { isTerminalRequestError } from "../../../lib/api/client.js";
import {
	advanceTransferExport,
	createTransferExport,
	fetchTransferExportManifest,
	fetchTransferExports,
	transferExportArchiveUrl,
	TRANSFER_EXPORTS_QUERY_KEY,
	type TransferOperation,
	type TransferPage,
} from "../../../lib/api/transfer.js";
import { formatFileSize } from "../../../lib/media-utils.js";
import { canStreamToDisk } from "../../../lib/save-file.js";
import { getMutationError } from "../../DialogError.js";
import { SettingRow, SettingsSection } from "../SettingsLayout.js";
import { CopyableDigest } from "./CopyableDigest.js";
import { ExportDownloadStatus, useExportDownload } from "./ExportDownload.js";
import {
	recordKindLabel,
	RECORD_KIND_ORDER,
	shortDigest,
	stageLabel,
	transferErrorLabel,
} from "./labels.js";
import { replaceOperation } from "./state.js";
import { useAdvanceLoop } from "./useAdvanceLoop.js";

const RECENT_EXPORTS = 10;
const START_RETRIES = 3;
/** Above this size, a browser without streaming saves holds too much in memory. */
const LARGE_IN_MEMORY_BYTES = 500 * 1024 * 1024;

function isRunning(operation: TransferOperation): boolean {
	return operation.state === "pending" || operation.state === "running";
}

function isDownloadable(operation: TransferOperation): boolean {
	return operation.state === "complete" && operation.stagingCollectedAt === null;
}

export function ExportSection() {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const [includeComments, setIncludeComments] = React.useState(true);
	const [loopError, setLoopError] = React.useState<unknown>(null);
	const [resumeToken, setResumeToken] = React.useState(0);
	const download = useExportDownload();

	const exportsQuery = useQuery({
		queryKey: TRANSFER_EXPORTS_QUERY_KEY,
		queryFn: () => fetchTransferExports({ limit: RECENT_EXPORTS }),
	});
	const exports = exportsQuery.data?.items ?? [];
	const running = exports.find(isRunning) ?? null;
	const latest = exports[0] ?? null;

	const startMutation = useMutation({
		mutationFn: createTransferExport,
		retry: (failureCount, error) => failureCount < START_RETRIES && !isTerminalRequestError(error),
		onSuccess: (operation) => {
			setLoopError(null);
			queryClient.setQueryData<TransferPage<TransferOperation>>(
				TRANSFER_EXPORTS_QUERY_KEY,
				(page) => replaceOperation(page ?? { items: [] }, operation),
			);
		},
	});

	useAdvanceLoop({
		key: running && loopError === null ? running.id : null,
		resumeToken,
		step: () => advanceTransferExport(running?.id ?? ""),
		onStep: (result) => {
			queryClient.setQueryData<TransferPage<TransferOperation>>(
				TRANSFER_EXPORTS_QUERY_KEY,
				(page) => replaceOperation(page, result.operation),
			);
		},
		onError: setLoopError,
	});

	const manifestQuery = useQuery({
		queryKey: ["transfer", "export-manifest", latest?.id],
		queryFn: () => fetchTransferExportManifest(latest?.id ?? ""),
		enabled: latest !== null && isDownloadable(latest),
		staleTime: Infinity,
	});

	return (
		<SettingsSection
			title={t`Export`}
			description={t`Download this site as a single .emdash package file that another EmDash site can import.`}
		>
			<SettingRow>
				<div className="grid gap-3 text-sm leading-5">
					<p className="font-medium">{t`What the package includes`}</p>
					<p className="text-pretty text-kumo-subtle">
						{t`Collections and fields, all content with drafts, revisions, scheduled posts, and trash, translations, taxonomies, bylines, media files, menus, widgets, sections, redirects, SEO, and site settings.`}
					</p>
					<p className="font-medium">{t`What it leaves out`}</p>
					<p className="text-pretty text-kumo-subtle">
						{t`User accounts, passkeys, API tokens, secrets, and plugin data are never exported. Each author’s name and email address are included so they can be matched to users on the other site.`}
					</p>
				</div>
			</SettingRow>
			<SettingRow>
				<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
					<Switch
						label={t`Include comments`}
						checked={includeComments}
						onCheckedChange={setIncludeComments}
						disabled={running !== null || startMutation.isPending}
					/>
					<Button
						onClick={() =>
							startMutation.mutate({
								comments: includeComments,
								idempotencyKey: crypto.randomUUID(),
							})
						}
						disabled={running !== null || startMutation.isPending || exportsQuery.isPending}
						icon={startMutation.isPending ? <Loader size="sm" /> : undefined}
					>
						{startMutation.isPending ? t`Starting…` : t`Export site`}
					</Button>
				</div>
				{startMutation.error ? (
					<Banner
						className="mt-3"
						variant="error"
						role="alert"
						title={t`Couldn’t start the export`}
						description={getMutationError(startMutation.error) ?? undefined}
					/>
				) : null}
			</SettingRow>

			{exportsQuery.isPending ? (
				<SettingRow>
					<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
						<Loader size="sm" />
						{t`Loading exports…`}
					</div>
				</SettingRow>
			) : exportsQuery.error ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`Couldn’t load exports`}
						description={getMutationError(exportsQuery.error) ?? undefined}
					/>
				</SettingRow>
			) : null}

			{running ? (
				<SettingRow>
					<ExportProgress
						operation={running}
						error={loopError}
						onRetry={() => {
							setLoopError(null);
							setResumeToken((value) => value + 1);
						}}
					/>
				</SettingRow>
			) : latest && latest.state === "failed" ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`The last export failed`}
						description={
							transferErrorLabel(i18n, latest.errorCode) ??
							t`Try again. If it keeps failing, check the server logs.`
						}
					/>
				</SettingRow>
			) : latest && isDownloadable(latest) ? (
				<SettingRow>
					<div className="grid gap-4">
						<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
							<div className="min-w-0">
								<h3 className="text-sm font-medium leading-5">{t`Export ready`}</h3>
								<p className="mt-0.5 text-sm leading-5 text-kumo-subtle">
									{i18n.date(new Date(latest.completedAt ?? latest.createdAt), {
										dateStyle: "medium",
										timeStyle: "short",
									})}
									{manifestQuery.data
										? ` · ${formatFileSize(manifestQuery.data.files.totalBytes)}`
										: null}
								</p>
							</div>
							<div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
								<Button
									variant="primary"
									icon={<DownloadSimple />}
									disabled={download.downloading}
									onClick={() => void download.start(latest)}
								>
									{t`Download package`}
								</Button>
								<LinkButton href={transferExportArchiveUrl(latest.id)} variant="ghost" size="sm">
									{t`Download as one file`}
								</LinkButton>
							</div>
						</div>
						<p className="max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
							{t`Download package fetches the export file by file and checks each one, so it works for sites of any size. Download as one file asks the server for a single archive, which is quicker for small sites but can fail for large sites on Cloudflare Workers.`}
						</p>
						{manifestQuery.data &&
						manifestQuery.data.files.totalBytes > LARGE_IN_MEMORY_BYTES &&
						!canStreamToDisk() ? (
							<Banner
								variant="alert"
								title={t`This export is large`}
								description={t`This browser keeps the whole package in memory until the download finishes. For an export this size, use a Chromium-based browser, which saves straight to disk, or run emdash site export from the CLI.`}
							/>
						) : null}
						<ExportDownloadStatus state={download.state} />
						{latest.packageDigest ? (
							<CopyableDigest label={t`Package digest`} digest={latest.packageDigest} />
						) : null}
						{manifestQuery.data ? (
							<dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
								{RECORD_KIND_ORDER.filter(
									(kind) => kind !== "principal" && manifestQuery.data.records[kind],
								).map((kind) => (
									<div key={kind} className="flex justify-between gap-2">
										<dt className="text-kumo-subtle">{recordKindLabel(i18n, kind)}</dt>
										<dd className="tabular-nums">
											{i18n.number(manifestQuery.data.records[kind]?.count ?? 0)}
										</dd>
									</div>
								))}
							</dl>
						) : null}
					</div>
				</SettingRow>
			) : null}

			{exports.length > 0 ? (
				<SettingRow>
					<h3 className="text-sm font-medium leading-5">{t`Recent exports`}</h3>
					<ul className="mt-2 divide-y divide-kumo-line">
						{exports.map((operation) => {
							const created = i18n.date(new Date(operation.createdAt), {
								dateStyle: "medium",
								timeStyle: "short",
							});
							return (
								<li
									key={operation.id}
									className="flex flex-col gap-2 py-2 sm:flex-row sm:items-center sm:justify-between"
								>
									<div className="min-w-0 text-sm">
										<div className="leading-5">{created}</div>
										{operation.packageDigest ? (
											<div className="font-mono text-xs leading-5 text-kumo-subtle" dir="ltr">
												{shortDigest(operation.packageDigest)}
											</div>
										) : null}
									</div>
									<div className="flex shrink-0 items-center gap-2 self-end sm:self-center">
										<ExportStateBadge operation={operation} />
										{isDownloadable(operation) ? (
											<Button
												variant="outline"
												size="sm"
												shape="square"
												disabled={download.downloading}
												aria-label={t`Download export from ${created}`}
												onClick={() => void download.start(operation)}
											>
												<DownloadSimple className="h-4 w-4" />
											</Button>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>
				</SettingRow>
			) : null}
		</SettingsSection>
	);
}

function ExportStateBadge({ operation }: { operation: TransferOperation }) {
	const { t } = useLingui();
	if (operation.state === "complete") {
		return operation.stagingCollectedAt === null ? (
			<Badge variant="success">{t`Ready`}</Badge>
		) : (
			<Badge variant="neutral">{t`Expired`}</Badge>
		);
	}
	if (operation.state === "failed") return <Badge variant="error">{t`Failed`}</Badge>;
	if (operation.state === "expired") return <Badge variant="neutral">{t`Expired`}</Badge>;
	return <Badge variant="warning">{t`Exporting`}</Badge>;
}

function ExportProgress({
	operation,
	error,
	onRetry,
}: {
	operation: TransferOperation;
	error: unknown;
	onRetry: () => void;
}) {
	const { t, i18n } = useLingui();
	const stage = stageLabel(i18n, operation.stage) ?? t`Starting`;
	const progress = operation.progress;
	const records = progress?.records ?? null;
	if (error) {
		return (
			<Banner
				variant="error"
				role="alert"
				title={t`The export stopped`}
				description={getMutationError(error) ?? undefined}
				action={
					<Button size="sm" variant="secondary" onClick={onRetry}>
						{t`Try again`}
					</Button>
				}
			/>
		);
	}
	return (
		<div className="flex items-start gap-3" role="status" aria-live="polite">
			<Loader size="sm" />
			<div className="min-w-0 flex-1 text-sm leading-5">
				<p className="font-medium">{t`Exporting: ${stage}`}</p>
				{progress && progress.total > 0 ? (
					<Meter
						className="my-2"
						label={t`Progress`}
						value={progress.done}
						max={progress.total}
						customValue={
							progress.bytesTotal !== undefined
								? t`${i18n.number(progress.done)} of ${i18n.number(progress.total)} steps · ${formatFileSize(progress.bytesDone ?? 0)} of ${formatFileSize(progress.bytesTotal)}`
								: t`${i18n.number(progress.done)} of ${i18n.number(progress.total)} steps`
						}
					/>
				) : null}
				{records !== null ? (
					<p className="text-kumo-subtle">
						{plural(records, { one: "# record written", other: "# records written" })}
					</p>
				) : null}
				<p className="mt-1 text-kumo-subtle">
					{t`Keep this page open. If you leave, the export continues when you come back.`}
				</p>
			</div>
		</div>
	);
}
