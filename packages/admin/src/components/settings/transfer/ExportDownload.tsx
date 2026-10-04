import { Banner, Button, Loader, Meter } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import type { TransferOperation } from "../../../lib/api/transfer.js";
import { formatFileSize } from "../../../lib/media-utils.js";
import { openSaveTarget } from "../../../lib/save-file.js";
import { downloadSitePackage, type DownloadProgress } from "../../../lib/transfer-download.js";
import { SitePackageError, SITE_PACKAGE_EXTENSION } from "../../../lib/transfer-package.js";
import { getMutationError } from "../../DialogError.js";
import { packageErrorLabel } from "./labels.js";

type DownloadState =
	| { status: "idle" }
	| {
			status: "downloading";
			operationId: string;
			progress: DownloadProgress | null;
			controller: AbortController;
	  }
	| { status: "done"; operationId: string }
	| { status: "failed"; operationId: string; error: unknown };

/** Download an export file by file into a `.emdash` archive, one at a time. */
export function useExportDownload() {
	const { t } = useLingui();
	const [state, setState] = React.useState<DownloadState>({ status: "idle" });
	const active = React.useRef<AbortController | null>(null);
	React.useEffect(() => () => active.current?.abort(), []);

	const start = React.useCallback(
		async (operation: TransferOperation) => {
			if (active.current || !operation.packageDigest) return;
			const packageDigest = operation.packageDigest;
			let target;
			try {
				target = await openSaveTarget({
					suggestedName: `emdash-site-${operation.id}${SITE_PACKAGE_EXTENSION}`,
					description: t`EmDash site package`,
					mediaType: "application/x-tar",
					extension: SITE_PACKAGE_EXTENSION,
				});
			} catch (error) {
				setState({ status: "failed", operationId: operation.id, error });
				return;
			}
			if (!target) return;
			const controller = new AbortController();
			active.current = controller;
			setState({ status: "downloading", operationId: operation.id, progress: null, controller });
			try {
				await downloadSitePackage({
					operationId: operation.id,
					packageDigest,
					sink: target.sink,
					signal: controller.signal,
					onProgress: (progress) =>
						setState({ status: "downloading", operationId: operation.id, progress, controller }),
				});
				target.finish();
				setState({ status: "done", operationId: operation.id });
			} catch (error) {
				setState(
					controller.signal.aborted
						? { status: "idle" }
						: { status: "failed", operationId: operation.id, error },
				);
			} finally {
				active.current = null;
			}
		},
		[t],
	);

	return { state, start, downloading: state.status === "downloading" };
}

export function ExportDownloadStatus({
	state,
}: {
	state: ReturnType<typeof useExportDownload>["state"];
}) {
	const { t, i18n } = useLingui();
	if (state.status === "idle") return null;
	if (state.status === "done") {
		return (
			<p className="text-sm leading-5 text-kumo-success" role="status">
				{t`Package downloaded`}
			</p>
		);
	}
	if (state.status === "failed") {
		return (
			<Banner
				variant="error"
				role="alert"
				title={t`The download stopped`}
				description={
					state.error instanceof SitePackageError
						? packageErrorLabel(i18n, state.error.reason)
						: (getMutationError(state.error) ?? undefined)
				}
			/>
		);
	}
	const { progress } = state;
	return (
		<div className="grid gap-3" role="status" aria-live="polite">
			<div className="flex items-center justify-between gap-3">
				<div className="flex items-center gap-2 text-sm font-medium">
					<Loader size="sm" />
					{t`Downloading the package`}
				</div>
				<Button size="sm" variant="secondary" onClick={() => state.controller.abort()}>
					{t`Stop`}
				</Button>
			</div>
			{progress ? (
				<Meter
					label={t`Downloaded`}
					value={progress.bytesDone}
					max={Math.max(progress.bytesTotal, 1)}
					customValue={t`${i18n.number(progress.filesDone)} of ${i18n.number(progress.filesTotal)} files · ${formatFileSize(progress.bytesDone)} of ${formatFileSize(progress.bytesTotal)}`}
				/>
			) : null}
		</div>
	);
}
