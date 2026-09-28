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
