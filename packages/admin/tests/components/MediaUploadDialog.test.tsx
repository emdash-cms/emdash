import * as React from "react";
import { expect, it, vi } from "vitest";

import { MediaUploadDialog } from "../../src/components/MediaUploadDialog.js";
import { render } from "../utils/render.tsx";

it("settles one upload and reports queue idle once under Strict Mode", async () => {
	const upload = vi.fn().mockResolvedValue(undefined);
	const onQueueIdle = vi.fn();
	const file = new File(["pdf"], "strict.pdf", { type: "application/pdf" });
	const screen = await render(
		<React.StrictMode>
			<MediaUploadDialog
				open
				providerName="Library"
				enqueueRequest={{ id: 1, files: [file] }}
				onEnqueueRequestConsumed={vi.fn()}
				onOpenChange={vi.fn()}
				onCloseComplete={vi.fn()}
				onQueueIdle={onQueueIdle}
				upload={upload}
			/>
		</React.StrictMode>,
	);

	await vi.waitFor(() => {
		expect(upload).toHaveBeenCalledTimes(1);
		expect(onQueueIdle).toHaveBeenCalledTimes(1);
	});
	await expect.element(screen.getByText("Complete", { exact: true })).toBeInTheDocument();
});

it("shows the server's message on a failed upload", async () => {
	const upload = vi.fn().mockRejectedValue(new Error("size: File size must not exceed 50MB"));
	const file = new File(["video"], "huge.mp4", { type: "video/mp4" });
	const screen = await render(
		<MediaUploadDialog
			open
			providerName="Library"
			enqueueRequest={{ id: 1, files: [file] }}
			onEnqueueRequestConsumed={vi.fn()}
			onOpenChange={vi.fn()}
			onCloseComplete={vi.fn()}
			upload={upload}
		/>,
	);

	await expect.element(screen.getByText("Upload failed", { exact: true })).toBeInTheDocument();
	await expect
		.element(screen.getByText("size: File size must not exceed 50MB", { exact: true }))
		.toBeInTheDocument();
});
