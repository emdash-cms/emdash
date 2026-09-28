import { Badge, Banner, Button, Loader, Meter } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle, FileArrowUp } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	abandonTransferImport,
	advanceTransferImport,
	analyzeTransferImport,
	cancelTransferImport,
	fetchTransferImport,
	fetchTransferImports,
	TRANSFER_CAPABILITIES_QUERY_KEY,
	TRANSFER_IMPORTS_QUERY_KEY,
	type SiteImportReceipt,
	type TransferCapabilities,
	type TransferOperation,
	type TransferPage,
} from "../../../lib/api/transfer.js";
import { formatFileSize } from "../../../lib/media-utils.js";
import {
	EarlierImportWroteError,
	SITE_PACKAGE_EXTENSION,
	SitePackageError,
	uploadSitePackage,
	type UploadProgress,
} from "../../../lib/transfer-package.js";
import { ConfirmDialog } from "../../ConfirmDialog.js";
import { getMutationError } from "../../DialogError.js";
import { SettingRow, SettingsSection } from "../SettingsLayout.js";
import { CopyableDigest, useCopyToClipboard } from "./CopyableDigest.js";
import { ImportReview } from "./ImportReview.js";
import {
	domainBlockerLabel,
	issueLabel,
	packageErrorLabel,
	recordKindLabel,
	RECORD_KIND_ORDER,
	stageLabel,
	transferErrorLabel,
} from "./labels.js";
import {
	canAbandonImport,
	canCancelImport,
	importView,
	replaceOperation,
	selectCurrentImport,
} from "./state.js";
import { useAdvanceLoop } from "./useAdvanceLoop.js";

const RECENT_IMPORTS = 10;

export function ImportSection({ capabilities }: { capabilities: TransferCapabilities }) {
	const { t, i18n } = useLingui();
	const queryClient = useQueryClient();
	const [dismissed, setDismissed] = React.useState<ReadonlySet<string>>(() => new Set());
	const [upload, setUpload] = React.useState<{
		progress: UploadProgress | null;
		controller: AbortController;
	} | null>(null);
	const [uploadError, setUploadError] = React.useState<unknown>(null);
	const [loopError, setLoopError] = React.useState<unknown>(null);
	const [resumeToken, setResumeToken] = React.useState(0);
	const [confirmAction, setConfirmAction] = React.useState<"cancel" | "abandon" | null>(null);
	const fileInput = React.useRef<HTMLInputElement>(null);

	const importsQuery = useQuery({
		queryKey: TRANSFER_IMPORTS_QUERY_KEY,
		queryFn: () => fetchTransferImports({ limit: RECENT_IMPORTS }),
	});
	const current = selectCurrentImport(importsQuery.data?.items ?? [], dismissed);

	const statusQuery = useQuery({
		queryKey: ["transfer", "import-status", current?.id],
		queryFn: () => fetchTransferImport(current?.id ?? ""),
		enabled: current?.state === "uploading" && upload === null,
	});
	const filesMissing =
		current?.state === "uploading" && statusQuery.data?.operation.id === current.id
			? statusQuery.data.files.declared
			: null;

	const eligible = capabilities.portableDomain.empty;
	const view = importView({ eligible, current, uploading: upload !== null, filesMissing });

	const setOperation = React.useCallback(
		(operation: TransferOperation) => {
			queryClient.setQueryData<TransferPage<TransferOperation>>(
				TRANSFER_IMPORTS_QUERY_KEY,
				(page) => replaceOperation(page ?? { items: [] }, operation),
			);
		},
		[queryClient],
	);

	const refreshAfterEnd = React.useCallback(() => {
		void queryClient.invalidateQueries({ queryKey: TRANSFER_CAPABILITIES_QUERY_KEY });
		void queryClient.invalidateQueries({ queryKey: TRANSFER_IMPORTS_QUERY_KEY });
	}, [queryClient]);

	const loopKey =
		loopError === null && (view.view === "analyzing" || view.view === "executing")
			? `${view.view}:${view.operation.id}`
			: null;
	useAdvanceLoop({
		key: loopKey,
		resumeToken,
		step: async () => {
			if (view.view === "analyzing") {
				const result = await analyzeTransferImport(view.operation.id);
				if (result.plan && result.planDigest) {
					queryClient.setQueryData(["transfer", "import-plan", view.operation.id], {
						plan: result.plan,
						planDigest: result.planDigest,
					});
				}
				return result;
			}
			if (view.view === "executing") return advanceTransferImport(view.operation.id);
			return { operation: current as TransferOperation, nextRequestInMs: null };
		},
		onStep: (result) => {
			setOperation(result.operation);
			if (result.nextRequestInMs === null && result.operation.kind === "import") {
				if (result.operation.state !== "planned") refreshAfterEnd();
			}
		},
		onError: setLoopError,
	});

	const startUpload = async (
		file: File,
		expectedPackageDigest: TransferOperation["packageDigest"],
	) => {
		const controller = new AbortController();
		setUploadError(null);
		setLoopError(null);
		setUpload({ progress: null, controller });
		try {
			const operation = await uploadSitePackage({
				file,
				limits: {
					manifestBytes: capabilities.limits.manifestBytes,
					chunkBytes: capabilities.limits.chunkBytes,
					maxBlobBytes: capabilities.limits.maxBlobBytes,
				},
				expectedPackageDigest,
				signal: controller.signal,
				onOperation: setOperation,
				onProgress: (progress) => setUpload({ progress, controller }),
			});
			setOperation(operation);
		} catch (error) {
			if (!controller.signal.aborted) setUploadError(error);
			if (error instanceof EarlierImportWroteError) refreshAfterEnd();
		} finally {
			await queryClient.invalidateQueries({ queryKey: ["transfer", "import-status"] });
			setUpload(null);
		}
	};

	const onFileChosen = (event: React.ChangeEvent<HTMLInputElement>) => {
		const file = event.target.files?.[0];
		event.target.value = "";
		if (!file) return;
		void startUpload(file, view.view === "needs-file" ? view.operation.packageDigest : null);
	};

	const cancelMutation = useMutation({
		mutationFn: (id: string) => cancelTransferImport(id),
		onSuccess: (operation) => {
			setConfirmAction(null);
			setOperation(operation);
			refreshAfterEnd();
		},
	});
	const abandonMutation = useMutation({
		mutationFn: (id: string) => abandonTransferImport(id),
		onSuccess: (operation) => {
			setConfirmAction(null);
			setOperation(operation);
			refreshAfterEnd();
		},
	});

	const chooseButton = (label: string) => (
		<>
			<input
				ref={fileInput}
				type="file"
				accept={SITE_PACKAGE_EXTENSION}
				className="sr-only"
				tabIndex={-1}
				aria-hidden="true"
				onChange={onFileChosen}
			/>
			<Button icon={<FileArrowUp />} onClick={() => fileInput.current?.click()}>
				{label}
			</Button>
		</>
	);

	const operation = "operation" in view ? view.operation : null;
	const cancellable = operation !== null && canCancelImport(operation);

	return (
		<SettingsSection
			title={t`Import`}
			description={t`Replace this site’s content with a package exported from another EmDash site.`}
			actions={
				cancellable ? (
					<Button variant="secondary" onClick={() => setConfirmAction("cancel")}>
						{t`Cancel import`}
					</Button>
				) : undefined
			}
		>
			{importsQuery.isPending || (view.view === "needs-file" && statusQuery.isPending) ? (
				<SettingRow>
					<div className="flex items-center gap-2 text-sm text-kumo-subtle" role="status">
						<Loader size="sm" />
						{t`Loading imports…`}
					</div>
				</SettingRow>
			) : importsQuery.error ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`Couldn’t load imports`}
						description={getMutationError(importsQuery.error) ?? undefined}
					/>
				</SettingRow>
			) : view.view === "ineligible" ? (
				<IneligibleNotice capabilities={capabilities} />
			) : view.view === "choose" ? (
				<SettingRow>
					<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<p className="max-w-xl text-sm leading-5 text-pretty text-kumo-subtle">
							{t`This site has no content yet, so it can receive an import. Choose a .emdash package file. It is checked in your browser and uploaded in parts; nothing on this site changes until you review and confirm the import.`}
						</p>
						{chooseButton(t`Choose package file`)}
					</div>
				</SettingRow>
			) : view.view === "uploading" ? (
				<SettingRow>
					<UploadProgressView
						progress={upload?.progress ?? null}
						onStop={() => upload?.controller.abort()}
					/>
				</SettingRow>
			) : view.view === "needs-file" ? (
				<SettingRow>
					<div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
						<div className="max-w-xl text-sm leading-5">
							<p className="font-medium">{t`Upload not finished`}</p>
							<p className="mt-0.5 text-pretty text-kumo-subtle">
								{filesMissing === null
									? t`Choose the same package file again to finish uploading it.`
									: plural(filesMissing, {
											one: "# file still needs to be uploaded. Choose the same package file again to finish; files already uploaded are skipped.",
											other:
												"# files still need to be uploaded. Choose the same package file again to finish; files already uploaded are skipped.",
										})}
							</p>
						</div>
						{chooseButton(t`Choose package file`)}
					</div>
				</SettingRow>
			) : view.view === "analyzing" ? (
				<SettingRow>
					<StageProgress
						title={t`Checking the package`}
						operation={view.operation}
						error={loopError}
						onRetry={() => {
							setLoopError(null);
							setResumeToken((value) => value + 1);
						}}
						note={t`The package is checked against this site before anything changes. You can leave this page and come back.`}
					/>
				</SettingRow>
			) : view.view === "review" ? (
				<ImportReview
					operation={view.operation}
					capabilities={capabilities}
					onExecuted={setOperation}
				/>
			) : view.view === "executing" ? (
				<SettingRow>
					<StageProgress
						title={view.operation.cancelRequestedAt ? t`Stopping the import` : t`Importing`}
						operation={view.operation}
						error={loopError}
						onRetry={() => {
							setLoopError(null);
							setResumeToken((value) => value + 1);
						}}
						note={t`Editing is paused until the import finishes. Keep this page open; if you leave, the import continues when you come back.`}
					/>
				</SettingRow>
			) : view.view === "complete" ? (
				<ImportReceiptView operation={view.operation} />
			) : (
				<StoppedNotice
					operation={view.operation}
					eligible={eligible}
					onAbandon={() => setConfirmAction("abandon")}
					onDismiss={() => setDismissed((previous) => new Set([...previous, view.operation.id]))}
				/>
			)}

			{uploadError instanceof EarlierImportWroteError ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`This site holds partial data from an earlier import`}
						description={
							uploadError.operation.state === "abandoned"
								? t`An earlier import of this package wrote to this site before it was abandoned. Reset this site or set up a new one before importing again.`
								: t`An earlier import of this package stopped after it started writing to this site. Abandon that import, then reset this site or set up a new one before importing again.`
						}
					/>
				</SettingRow>
			) : uploadError ? (
				<SettingRow>
					<Banner
						variant="error"
						role="alert"
						title={t`The package couldn’t be uploaded`}
						description={
							uploadError instanceof SitePackageError
								? packageErrorLabel(i18n, uploadError.reason)
								: (getMutationError(uploadError) ?? undefined)
						}
					/>
				</SettingRow>
			) : null}

			<ConfirmDialog
				open={confirmAction === "cancel" && operation !== null}
				onClose={() => {
					setConfirmAction(null);
					cancelMutation.reset();
				}}
				title={t`Cancel this import?`}
				description={
					operation && operation.mutationStartedAt
						? t`The import stops after its current step. Content already imported stays on the site, and editing stays paused until you abandon the import.`
						: t`The uploaded package is discarded. Nothing on this site has changed.`
				}
				confirmLabel={t`Cancel import`}
				cancelLabel={t`Keep importing`}
				pendingLabel={t`Cancelling…`}
				isPending={cancelMutation.isPending}
				error={cancelMutation.error}
				onConfirm={() => operation && cancelMutation.mutate(operation.id)}
			/>
			<ConfirmDialog
				open={confirmAction === "abandon" && operation !== null}
				onClose={() => {
					setConfirmAction(null);
					abandonMutation.reset();
				}}
				title={t`Abandon this import?`}
				description={t`Editing is unlocked again. Content the import already wrote stays on the site and is not removed. Because the site is no longer empty, another import can’t run here.`}
				confirmLabel={t`Abandon import`}
				pendingLabel={t`Abandoning…`}
				isPending={abandonMutation.isPending}
				error={abandonMutation.error}
				onConfirm={() => operation && abandonMutation.mutate(operation.id)}
			/>
		</SettingsSection>
	);
}

function IneligibleNotice({ capabilities }: { capabilities: TransferCapabilities }) {
	const { t, i18n } = useLingui();
	const blockers = capabilities.portableDomain.blockers;
	return (
		<SettingRow>
			<div className="grid gap-3 text-sm leading-5">
				<div>
					<p className="font-medium">{t`This site can’t receive an import`}</p>
					<p className="mt-0.5 max-w-2xl text-pretty text-kumo-subtle">
						{t`An import replaces a new site’s starter content, so it only runs on a site with no content of its own. To move content here, set up a new EmDash site and import into that. These are what this site already has:`}
					</p>
				</div>
				<ul className="list-disc space-y-1 ps-5 text-kumo-subtle">
					{blockers.map((blocker, index) => (
						<li key={index}>{domainBlockerLabel(i18n, blocker)}</li>
					))}
				</ul>
			</div>
		</SettingRow>
	);
}

function UploadProgressView({
	progress,
	onStop,
}: {
	progress: UploadProgress | null;
	onStop: () => void;
}) {
	const { t, i18n } = useLingui();
	const reading = !progress || progress.phase === "reading";
	return (
		<div className="grid gap-3" role="status" aria-live="polite">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 text-sm font-medium">
					<Loader size="sm" />
					{reading ? t`Reading the package` : t`Uploading the package`}
				</div>
				<Button size="sm" variant="secondary" onClick={onStop}>
					{t`Stop`}
				</Button>
			</div>
			{progress && !reading ? (
				<Meter
					label={t`Uploaded`}
					value={progress.bytesDone}
					max={Math.max(progress.bytesTotal, 1)}
					customValue={t`${i18n.number(progress.filesDone)} of ${i18n.number(progress.filesTotal)} files · ${formatFileSize(progress.bytesDone)} of ${formatFileSize(progress.bytesTotal)}`}
				/>
			) : null}
			<p className="text-sm leading-5 text-kumo-subtle">
				{t`Keep this page open while files upload. If the upload stops, choose the same file again to continue where it left off.`}
			</p>
		</div>
	);
}

function StageProgress({
	title,
	operation,
	error,
	onRetry,
	note,
}: {
	title: string;
	operation: TransferOperation;
	error: unknown;
	onRetry: () => void;
	note: string;
}) {
	const { t, i18n } = useLingui();
	if (error) {
		return (
			<Banner
				variant="error"
				role="alert"
				title={t`Progress stopped`}
				description={getMutationError(error) ?? undefined}
				action={
					<Button size="sm" variant="secondary" onClick={onRetry}>
						{t`Try again`}
					</Button>
				}
			/>
		);
	}
	const stage = stageLabel(i18n, operation.stage);
	const progress = operation.progress;
	const retrying = transferErrorLabel(i18n, operation.errorCode);
	return (
		<div className="grid gap-3" role="status" aria-live="polite">
			<div className="flex items-center gap-2 text-sm font-medium">
				<Loader size="sm" />
				{stage ? `${title}: ${stage}` : title}
			</div>
			{progress && progress.total > 0 ? (
				<Meter
					label={t`Progress`}
					value={progress.done}
					max={progress.total}
					customValue={t`${i18n.number(progress.done)} of ${i18n.number(progress.total)} steps`}
				/>
			) : null}
			{operation.errorCode ? (
				<p className="text-sm leading-5 text-kumo-warning">
					{retrying ?? t`A step failed and will be retried (${operation.errorCode}).`}
				</p>
			) : null}
			<p className="text-sm leading-5 text-kumo-subtle">{note}</p>
		</div>
	);
}

function StoppedNotice({
	operation,
	eligible,
	onAbandon,
	onDismiss,
}: {
	operation: TransferOperation;
	eligible: boolean;
	onAbandon: () => void;
	onDismiss: () => void;
}) {
	const { t, i18n } = useLingui();
	const cancelled = operation.state === "cancelled";
	const abandonable = canAbandonImport(operation);
	const reason = transferErrorLabel(i18n, operation.errorCode);
	return (
		<SettingRow>
			<Banner
				variant={cancelled ? "alert" : "error"}
				role="alert"
				title={cancelled ? t`The import was cancelled` : t`The import failed`}
				description={
					abandonable
						? t`The import stopped after it started writing to this site, so editing is paused. Abandon the import to unlock editing; content it already wrote stays in place.`
						: (reason ??
							(operation.errorCode
								? t`The import stopped (${operation.errorCode}). Nothing on this site changed.`
								: t`Nothing on this site changed.`))
				}
				action={
					abandonable ? (
						<Button size="sm" variant="destructive" onClick={onAbandon}>
							{t`Abandon import`}
						</Button>
					) : eligible ? (
						<Button size="sm" variant="secondary" onClick={onDismiss}>
							{t`Start a new import`}
						</Button>
					) : undefined
				}
			/>
			{abandonable && reason ? (
				<p className="mt-3 text-sm leading-5 text-kumo-subtle">{reason}</p>
			) : null}
		</SettingRow>
	);
}

function ImportReceiptView({ operation }: { operation: TransferOperation }) {
	const { t, i18n } = useLingui();
	const [copied, copy] = useCopyToClipboard();
	const receipt: SiteImportReceipt | null = operation.receipt;
	if (!receipt) {
		return (
			<SettingRow>
				<Banner variant="default" title={t`Import complete`} />
			</SettingRow>
		);
	}
	const counts = RECORD_KIND_ORDER.filter((kind) => (receipt.counts[kind] ?? 0) > 0);
	return (
		<>
			<SettingRow>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-medium leading-5">{t`Import complete`}</h3>
							<Badge variant="success" className="gap-1">
								<CheckCircle className="h-3.5 w-3.5" weight="fill" aria-hidden="true" />
								{t`Verified`}
							</Badge>
						</div>
						<p className="mt-0.5 max-w-2xl text-sm leading-5 text-pretty text-kumo-subtle">
							{t`Every imported record and media file was read back and matched the package. Keep this receipt as a record of the transfer.`}
						</p>
						<p className="mt-1 text-sm leading-5 text-kumo-subtle">
							{i18n.date(new Date(receipt.completedAt), {
								dateStyle: "medium",
								timeStyle: "short",
							})}
						</p>
					</div>
					<Button variant="secondary" onClick={() => void copy(JSON.stringify(receipt, null, 2))}>
						{copied ? t`Copied` : t`Copy receipt`}
					</Button>
				</div>
			</SettingRow>
			<SettingRow>
				<dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
					{counts.map((kind) => (
						<div key={kind} className="flex justify-between gap-2">
							<dt className="text-kumo-subtle">{recordKindLabel(i18n, kind)}</dt>
							<dd className="tabular-nums">{i18n.number(receipt.counts[kind] ?? 0)}</dd>
						</div>
					))}
				</dl>
			</SettingRow>
			<SettingRow>
				<div className="grid gap-3">
					<CopyableDigest label={t`Receipt digest`} digest={receipt.receiptDigest} />
					<CopyableDigest label={t`Package digest`} digest={receipt.packageDigest} />
					<CopyableDigest label={t`Plan digest`} digest={receipt.planDigest} />
					<CopyableDigest label={t`Content digest`} digest={receipt.logicalDigest} />
				</div>
			</SettingRow>
			{receipt.warnings.length > 0 ? (
				<SettingRow>
					<h4 className="text-sm font-medium leading-5">{t`Warnings`}</h4>
					<ul className="mt-2 list-disc space-y-1 ps-5 text-sm leading-5 text-kumo-subtle">
						{receipt.warnings.map((warning, index) => (
							<li key={index}>{issueLabel(i18n, warning.code)}</li>
						))}
					</ul>
				</SettingRow>
			) : null}
		</>
	);
}
