import * as React from "react";

const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 6;
const MAX_VISIBLE_JOBS = 100;

export type MediaUploadJobStatus = "queued" | "uploading" | "complete" | "failed";

export interface MediaUploadJob<TResult> {
	id: number;
	file: File;
	status: MediaUploadJobStatus;
	attempt: number;
	previewUrl?: string;
	result?: TResult;
}

interface UseMediaUploadQueueOptions<TResult> {
	upload: (
		file: File,
		options: { signal: AbortSignal; jobId: number; attempt: number },
	) => Promise<TResult>;
	concurrency?: number;
	createPreviewUrl?: (file: File) => string | undefined;
	onQueueIdle?: () => void;
}

export function useMediaUploadQueue<TResult>({
	upload,
	concurrency = DEFAULT_CONCURRENCY,
	createPreviewUrl,
	onQueueIdle,
}: UseMediaUploadQueueOptions<TResult>) {
	const [jobs, setJobs] = React.useState<MediaUploadJob<TResult>[]>([]);
	const [overflowCount, setOverflowCount] = React.useState(0);
	const jobsRef = React.useRef<MediaUploadJob<TResult>[]>([]);
	const activeRef = React.useRef(
		new Map<number, { attempt: number; controller: AbortController }>(),
	);
	const nextIdRef = React.useRef(0);
	const busyRunRef = React.useRef(false);
	const unmountingRef = React.useRef(false);
	const requestedConcurrency = Number.isFinite(concurrency)
		? Math.floor(concurrency)
		: DEFAULT_CONCURRENCY;
	const maxConcurrent = Math.min(MAX_CONCURRENCY, Math.max(1, requestedConcurrency));

	const updateJobs = React.useCallback(
		(update: (current: MediaUploadJob<TResult>[]) => MediaUploadJob<TResult>[]) => {
			const next = update(jobsRef.current);
			jobsRef.current = next;
			setJobs(next);
		},
		[],
	);

	const addFiles = React.useCallback(
		(files: readonly File[]) => {
			const available = Math.max(0, MAX_VISIBLE_JOBS - jobsRef.current.length);
			const accepted = files.slice(0, available);
			setOverflowCount(Math.max(0, files.length - accepted.length));
			if (accepted.length === 0) return [];

			busyRunRef.current = true;
			const added = accepted.map((file): MediaUploadJob<TResult> => {
				let previewUrl: string | undefined;
				try {
					previewUrl = createPreviewUrl?.(file);
				} catch {
					previewUrl = undefined;
				}
				return {
					id: (nextIdRef.current += 1),
					file,
					status: "queued",
					attempt: 1,
					previewUrl,
				};
			});
			updateJobs((current) => [...current, ...added]);
			return added;
		},
		[createPreviewUrl, updateJobs],
	);

	React.useEffect(() => {
		const slots = maxConcurrent - activeRef.current.size;
		if (slots <= 0) return;
		const candidates = jobsRef.current
			.filter((job) => job.status === "queued" && !activeRef.current.has(job.id))
			.slice(0, slots);
		if (candidates.length === 0) return;

		for (const job of candidates) {
			const controller = new AbortController();
			activeRef.current.set(job.id, { attempt: job.attempt, controller });
			updateJobs((current) =>
				current.map((item) =>
					item.id === job.id && item.attempt === job.attempt
						? { ...item, status: "uploading" }
						: item,
				),
			);

			void Promise.resolve()
				.then(() =>
					upload(job.file, {
						signal: controller.signal,
						jobId: job.id,
						attempt: job.attempt,
					}),
				)
				.then(
					(result) => {
						const active = activeRef.current.get(job.id);
						if (active?.attempt !== job.attempt) return undefined;
						activeRef.current.delete(job.id);
						updateJobs((current) =>
							current.map((item) =>
								item.id === job.id && item.attempt === job.attempt
									? { ...item, status: "complete", result }
									: item,
							),
						);
						return undefined;
					},
					() => {
						const active = activeRef.current.get(job.id);
						if (active?.attempt !== job.attempt) return undefined;
						activeRef.current.delete(job.id);
						if (controller.signal.aborted) return undefined;
						updateJobs((current) =>
							current.map((item) =>
								item.id === job.id && item.attempt === job.attempt
									? { ...item, status: "failed" }
									: item,
							),
						);
						return undefined;
					},
				);
		}
	}, [jobs, maxConcurrent, updateJobs, upload]);

	const hasUnfinished = jobs.some((job) => job.status === "queued" || job.status === "uploading");
	React.useEffect(() => {
		if (hasUnfinished || !busyRunRef.current || unmountingRef.current) return;
		busyRunRef.current = false;
		onQueueIdle?.();
	}, [hasUnfinished, onQueueIdle]);

	React.useEffect(() => {
		unmountingRef.current = false;
		return () => {
			unmountingRef.current = true;
			activeRef.current.forEach(({ controller }) => controller.abort());
			activeRef.current.clear();
			jobsRef.current.forEach((job) => job.previewUrl && URL.revokeObjectURL(job.previewUrl));
		};
	}, []);

	const remove = React.useCallback(
		(id: number) => {
			const job = jobsRef.current.find((item) => item.id === id);
			if (!job) return;
			activeRef.current.get(id)?.controller.abort();
			activeRef.current.delete(id);
			if (job.previewUrl) URL.revokeObjectURL(job.previewUrl);
			updateJobs((current) => current.filter((item) => item.id !== id));
		},
		[updateJobs],
	);

	const retry = React.useCallback(
		(id: number) => {
			if (!jobsRef.current.some((job) => job.id === id && job.status === "failed")) return;
			busyRunRef.current = true;
			updateJobs((current) =>
				current.map((job) =>
					job.id === id && job.status === "failed"
						? { ...job, status: "queued", attempt: job.attempt + 1, result: undefined }
						: job,
				),
			);
		},
		[updateJobs],
	);

	const retryFailed = React.useCallback(() => {
		if (!jobsRef.current.some((job) => job.status === "failed")) return;
		busyRunRef.current = true;
		updateJobs((current) =>
			current.map((job) =>
				job.status === "failed"
					? { ...job, status: "queued", attempt: job.attempt + 1, result: undefined }
					: job,
			),
		);
	}, [updateJobs]);

	const cancelUnfinished = React.useCallback(() => {
		activeRef.current.forEach(({ controller }) => controller.abort());
		activeRef.current.clear();
		jobsRef.current
			.filter((job) => job.status === "queued" || job.status === "uploading")
			.forEach((job) => job.previewUrl && URL.revokeObjectURL(job.previewUrl));
		updateJobs((current) =>
			current.filter((job) => job.status !== "queued" && job.status !== "uploading"),
		);
	}, [updateJobs]);

	const clearCompleted = React.useCallback(() => {
		jobsRef.current
			.filter((job) => job.status === "complete")
			.forEach((job) => job.previewUrl && URL.revokeObjectURL(job.previewUrl));
		updateJobs((current) => current.filter((job) => job.status !== "complete"));
	}, [updateJobs]);

	const reset = React.useCallback(() => {
		activeRef.current.forEach(({ controller }) => controller.abort());
		activeRef.current.clear();
		jobsRef.current.forEach((job) => job.previewUrl && URL.revokeObjectURL(job.previewUrl));
		jobsRef.current = [];
		setJobs([]);
		setOverflowCount(0);
		busyRunRef.current = false;
	}, []);

	return {
		jobs,
		overflowCount,
		hasUnfinished,
		completedCount: jobs.filter((job) => job.status === "complete").length,
		failedCount: jobs.filter((job) => job.status === "failed").length,
		addFiles,
		remove,
		retry,
		retryFailed,
		cancelUnfinished,
		clearCompleted,
		reset,
	};
}
