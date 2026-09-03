import { expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { useMediaUploadQueue } from "../../src/components/media/useMediaUploadQueue.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

it("keeps file order and starts no more than the configured upload limit", async () => {
	const files = ["first.png", "second.png", "third.png"].map(
		(name) => new File([name], name, { type: "image/png" }),
	);
	const pending = new Map(files.map((file) => [file.name, deferred<string>()]));
	const upload = vi.fn((file: File) => pending.get(file.name)!.promise);
	const onQueueIdle = vi.fn();
	const { result, act } = await renderHook(() =>
		useMediaUploadQueue({ upload, concurrency: 2, onQueueIdle }),
	);

	await act(() => result.current.addFiles(files));
	await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(2));
	expect(result.current.jobs.map((job) => job.file.name)).toEqual([
		"first.png",
		"second.png",
		"third.png",
	]);
	expect(result.current.jobs.map((job) => job.status)).toEqual([
		"uploading",
		"uploading",
		"queued",
	]);

	pending.get("second.png")!.resolve("second-result");
	await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(3));
	pending.get("third.png")!.resolve("third-result");
	pending.get("first.png")!.resolve("first-result");

	await vi.waitFor(() => expect(result.current.hasUnfinished).toBe(false));
	expect(result.current.jobs.map((job) => job.result)).toEqual([
		"first-result",
		"second-result",
		"third-result",
	]);
	expect(onQueueIdle).toHaveBeenCalledTimes(1);
});

it("retries a failed file as a new attempt", async () => {
	const file = new File(["image"], "retry.png", { type: "image/png" });
	const upload = vi
		.fn<(file: File, options: { signal: AbortSignal }) => Promise<string>>()
		.mockRejectedValueOnce(new Error("network failure"))
		.mockResolvedValueOnce("uploaded");
	const { result, act } = await renderHook(() => useMediaUploadQueue({ upload }));

	await act(() => result.current.addFiles([file]));
	await vi.waitFor(() => expect(result.current.jobs[0]?.status).toBe("failed"));

	await act(() => result.current.retry(result.current.jobs[0]!.id));
	await vi.waitFor(() => expect(result.current.jobs[0]?.status).toBe("complete"));
	expect(result.current.jobs[0]).toMatchObject({ attempt: 2, result: "uploaded" });
});

it("aborts a removed upload and ignores its late completion", async () => {
	const file = new File(["image"], "cancel.png", { type: "image/png" });
	const pending = deferred<string>();
	let signal: AbortSignal | undefined;
	const upload = vi.fn((_file: File, options: { signal: AbortSignal }) => {
		signal = options.signal;
		return pending.promise;
	});
	const { result, act } = await renderHook(() => useMediaUploadQueue({ upload }));

	await act(() => result.current.addFiles([file]));
	await vi.waitFor(() => expect(result.current.jobs[0]?.status).toBe("uploading"));
	await act(() => result.current.remove(result.current.jobs[0]!.id));

	expect(signal?.aborted).toBe(true);
	pending.resolve("too late");
	await vi.waitFor(() => expect(result.current.jobs).toHaveLength(0));
});

it("aborts active work and revokes previews when unmounted", async () => {
	const file = new File(["image"], "unmount.png", { type: "image/png" });
	let signal: AbortSignal | undefined;
	const upload = vi.fn((_file: File, options: { signal: AbortSignal }) => {
		signal = options.signal;
		return new Promise<void>(() => undefined);
	});
	const revokeObjectUrl = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
	const { result, act, unmount } = await renderHook(() =>
		useMediaUploadQueue({
			upload,
			createPreviewUrl: () => "blob:queue-preview",
		}),
	);

	await act(() => result.current.addFiles([file]));
	await vi.waitFor(() => expect(signal).toBeDefined());
	await unmount();

	expect(signal?.aborted).toBe(true);
	expect(revokeObjectUrl).toHaveBeenCalledWith("blob:queue-preview");
	revokeObjectUrl.mockRestore();
});

it("bounds the visible queue to 100 files", async () => {
	const files = Array.from(
		{ length: 101 },
		(_, index) => new File([String(index)], `file-${index}.txt`, { type: "text/plain" }),
	);
	const upload = vi.fn(() => new Promise<void>(() => undefined));
	const { result, act } = await renderHook(() => useMediaUploadQueue({ upload, concurrency: 1 }));

	await act(() => result.current.addFiles(files));

	expect(result.current.jobs).toHaveLength(100);
	expect(result.current.overflowCount).toBe(1);
});
