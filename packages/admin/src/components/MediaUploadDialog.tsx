import { Button, Dialog, Loader } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowClockwise,
	CheckCircle,
	File,
	FileAudio,
	FileImage,
	FilePdf,
	FileText,
	FileVideo,
	UploadSimple,
	WarningCircle,
	X,
} from "@phosphor-icons/react";
import * as React from "react";

import { formatFileSize } from "../lib/media-utils.js";
import {
	useMediaUploadQueue,
	type MediaUploadJob,
	type MediaUploadJobStatus,
} from "./media/useMediaUploadQueue.js";

export const LOCAL_MEDIA_UPLOAD_ACCEPT =
	"image/png,image/jpeg,image/gif,image/webp,image/avif,video/*,audio/*,application/pdf";

const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const PREVIEW_MIME_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
]);

export interface MediaUploadDialogProps {
	open: boolean;
	providerName: string;
	accept?: string;
	enqueueRequest: { id: number; files: readonly File[] } | null;
	onEnqueueRequestConsumed: (id: number) => void;
	onOpenChange: (open: boolean) => void;
	onCloseComplete: () => void;
	onQueueIdle?: () => void;
	upload: (file: File, options: { signal: AbortSignal }) => Promise<void>;
	concurrency?: number;
}

function previewUrlFor(file: File): string | undefined {
	if (file.size > MAX_PREVIEW_BYTES || !PREVIEW_MIME_TYPES.has(file.type)) return undefined;
	try {
		return URL.createObjectURL(file);
	} catch {
		return undefined;
	}
}

function FileKindIcon({ file }: { file: File }) {
	const className = "h-5 w-5";
	if (file.type.startsWith("image/")) return <FileImage className={className} aria-hidden="true" />;
	if (file.type.startsWith("video/")) return <FileVideo className={className} aria-hidden="true" />;
	if (file.type.startsWith("audio/")) return <FileAudio className={className} aria-hidden="true" />;
	if (file.type === "application/pdf") return <FilePdf className={className} aria-hidden="true" />;
	if (file.type.startsWith("text/") || file.type.includes("document")) {
		return <FileText className={className} aria-hidden="true" />;
	}
	return <File className={className} aria-hidden="true" />;
}

function UploadStatusLabel({ status }: { status: MediaUploadJobStatus }) {
	const { t } = useLingui();
	if (status === "uploading") {
		return (
			<>
				<Loader size="sm" />
				{t`Uploading`}
			</>
		);
	}
	if (status === "complete") {
		return (
			<>
				<CheckCircle className="h-4 w-4 text-kumo-success" weight="fill" aria-hidden="true" />
				{t`Complete`}
			</>
		);
	}
	if (status === "failed") {
		return (
			<>
				<WarningCircle className="h-4 w-4 text-kumo-danger" weight="fill" aria-hidden="true" />
				{t`Upload failed`}
			</>
		);
	}
	return <>{t`Queued`}</>;
}

function UploadFileRow({
	row,
	onCancel,
	onRetry,
	onRemove,
}: {
	row: MediaUploadJob<void>;
	onCancel: () => void;
	onRetry: () => void;
	onRemove: () => void;
}) {
	const { t } = useLingui();
	const isBusy = row.status === "queued" || row.status === "uploading";

	return (
		<li className="grid grid-cols-[2.5rem_minmax(0,1fr)_auto] items-center gap-3 rounded-lg bg-kumo-base px-3 py-2.5 ring ring-kumo-line">
			<div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-kumo-tint text-kumo-subtle">
				{row.previewUrl ? (
					<img
						src={row.previewUrl}
						alt=""
						loading="lazy"
						className="emdash-media-transparency-grid h-full w-full object-cover"
					/>
				) : (
					<FileKindIcon file={row.file} />
				)}
			</div>
			<div className="min-w-0">
				<p className="line-clamp-2 text-sm font-medium leading-5" title={row.file.name}>
					{row.file.name}
				</p>
				<div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-kumo-subtle">
					<span className="inline-flex items-center gap-1.5">
						<UploadStatusLabel status={row.status} />
					</span>
					<span aria-hidden="true">·</span>
					<span className="tabular-nums">{formatFileSize(row.file.size)}</span>
				</div>
			</div>
			<div className="flex items-center gap-1">
				{row.status === "failed" && (
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						onClick={onRetry}
						aria-label={t`Retry ${row.file.name}`}
						icon={<ArrowClockwise aria-hidden="true" />}
					/>
				)}
				<Button
					variant="ghost"
					shape="square"
					size="sm"
					onClick={isBusy ? onCancel : onRemove}
					aria-label={
						isBusy
							? t`Cancel ${row.file.name}`
							: row.status === "complete"
								? t`Dismiss completed ${row.file.name}`
								: t`Remove ${row.file.name}`
					}
					icon={<X aria-hidden="true" />}
				/>
			</div>
		</li>
	);
}

export function MediaUploadDialog({
	open,
	providerName,
	accept,
	enqueueRequest,
	onEnqueueRequestConsumed,
	onOpenChange,
	onCloseComplete,
	onQueueIdle,
	upload,
	concurrency,
}: MediaUploadDialogProps) {
	const { t } = useLingui();
	const lastRequestIdRef = React.useRef<number | null>(null);
	const inputRef = React.useRef<HTMLInputElement>(null);
	const {
		jobs: rows,
		overflowCount,
		hasUnfinished,
		completedCount,
		failedCount,
		addFiles,
		remove: removeRow,
		retry: retryRow,
		retryFailed,
		cancelUnfinished: cancelRemaining,
		clearCompleted,
		reset,
	} = useMediaUploadQueue({
		upload,
		concurrency,
		createPreviewUrl: previewUrlFor,
		onQueueIdle,
	});

	React.useEffect(() => {
		if (!open || !enqueueRequest || enqueueRequest.id === lastRequestIdRef.current) return;
		lastRequestIdRef.current = enqueueRequest.id;
		addFiles(enqueueRequest.files);
		onEnqueueRequestConsumed(enqueueRequest.id);
	}, [addFiles, enqueueRequest, onEnqueueRequestConsumed, open]);

	const liveMessage = hasUnfinished
		? t`${completedCount} of ${rows.length} uploads complete`
		: failedCount > 0
			? plural(failedCount, { one: "# upload failed", other: "# uploads failed" })
			: rows.length > 0
				? t`All uploads finished`
				: "";

	return (
		<Dialog.Root
			open={open}
			onOpenChange={(nextOpen) => {
				if (!nextOpen && hasUnfinished) return;
				onOpenChange(nextOpen);
			}}
			onOpenChangeComplete={(nextOpen) => {
				if (nextOpen) return;
				reset();
				onCloseComplete();
			}}
			disablePointerDismissal={hasUnfinished}
		>
			<Dialog
				size="lg"
				className="flex max-h-[min(88dvh,46rem)] flex-col overflow-hidden p-0"
				style={{ width: "min(94vw, 42rem)" }}
			>
				<div className="flex shrink-0 items-start justify-between gap-4 border-b border-kumo-line px-6 py-5">
					<div className="min-w-0">
						<Dialog.Title className="text-lg font-semibold leading-tight">
							{t`Upload to ${providerName}`}
						</Dialog.Title>
						<Dialog.Description className="mt-1 text-sm leading-5 text-kumo-subtle">
							{t`Files upload as soon as you add them.`}
						</Dialog.Description>
					</div>
					<Button
						variant="ghost"
						shape="square"
						size="sm"
						disabled={hasUnfinished}
						onClick={() => onOpenChange(false)}
						aria-label={t`Close`}
						icon={<X aria-hidden="true" />}
					/>
				</div>

				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-5">
					<div
						className="flex min-h-64 flex-col items-center justify-center gap-4 rounded-xl border-[3px] border-dashed border-kumo-subtle/60 bg-kumo-base px-6 py-10 text-center sm:min-h-72"
						onDragOver={(event) => event.preventDefault()}
						onDrop={(event) => {
							event.preventDefault();
							event.stopPropagation();
							addFiles([...event.dataTransfer.files]);
						}}
					>
						<div className="flex size-14 items-center justify-center rounded-full text-kumo-subtle ring ring-kumo-line">
							<UploadSimple className="h-7 w-7" weight="regular" aria-hidden="true" />
						</div>
						<div className="space-y-1">
							<p className="text-lg font-semibold leading-6">{t`Drag and drop files here`}</p>
							<p className="text-sm leading-5 text-kumo-subtle">
								{t`Or browse files from your computer`}
							</p>
						</div>
						<Button
							variant="outline"
							size="base"
							className="text-sm"
							onClick={() => inputRef.current?.click()}
							icon={<UploadSimple aria-hidden="true" />}
						>
							{t`Browse files`}
						</Button>
						<input
							ref={inputRef}
							type="file"
							multiple
							accept={accept}
							className="sr-only"
							tabIndex={-1}
							aria-label={t`Browse files to upload`}
							onChange={(event) => {
								addFiles([...(event.currentTarget.files ?? [])]);
								event.currentTarget.value = "";
							}}
						/>
					</div>

					{overflowCount > 0 && (
						<p role="alert" className="text-sm text-kumo-danger">
							{plural(overflowCount, {
								one: "# file was not added because the upload list is full.",
								other: "# files were not added because the upload list is full.",
							})}
						</p>
					)}

					{rows.length > 0 && (
						<ul className="space-y-2">
							{rows.map((row) => (
								<UploadFileRow
									key={row.id}
									row={row}
									onCancel={() => removeRow(row.id)}
									onRetry={() => retryRow(row.id)}
									onRemove={() => removeRow(row.id)}
								/>
							))}
						</ul>
					)}
				</div>

				<div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-t border-kumo-line px-6 py-4">
					<p className="text-sm text-kumo-subtle tabular-nums" aria-hidden="true">
						{rows.length > 0 ? t`${completedCount} of ${rows.length} complete` : t`No files added`}
					</p>
					<div className="flex flex-wrap items-center justify-end gap-2">
						{completedCount > 0 && (
							<Button variant="ghost" size="sm" onClick={clearCompleted}>
								{t`Clear completed`}
							</Button>
						)}
						{failedCount > 0 && (
							<Button
								variant="outline"
								size="sm"
								onClick={retryFailed}
								icon={<ArrowClockwise aria-hidden="true" />}
							>
								{t`Retry failed`}
							</Button>
						)}
						{hasUnfinished ? (
							<Button variant="outline" size="sm" onClick={cancelRemaining}>
								{t`Cancel remaining`}
							</Button>
						) : (
							<Button variant="primary" size="sm" onClick={() => onOpenChange(false)}>
								{t`Done`}
							</Button>
						)}
					</div>
				</div>

				<span className="sr-only" role="status" aria-live="polite">
					{liveMessage}
				</span>
			</Dialog>
		</Dialog.Root>
	);
}
