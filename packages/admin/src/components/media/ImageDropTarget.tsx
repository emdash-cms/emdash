import { Button, Loader } from "@cloudflare/kumo";
import { Trans, useLingui } from "@lingui/react/macro";
import { UploadSimple } from "@phosphor-icons/react";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { uploadMedia, type MediaItem } from "../../lib/api/media.js";
import { matchesMimeAllowlist } from "../../lib/mime-utils.js";
import { cn } from "../../lib/utils.js";
import { getMutationError } from "../DialogError.js";

interface ImageDropTargetProps {
	label: string;
	onSelect: () => void;
	onUploaded: (item: MediaItem) => void;
	allowedMimeTypes?: string[];
	fieldId?: string;
	className?: string;
}

export function ImageDropTarget({
	label,
	onSelect,
	onUploaded,
	allowedMimeTypes,
	fieldId,
	className,
}: ImageDropTargetProps) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [dragActive, setDragActive] = React.useState(false);
	const [uploading, setUploading] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const activeUpload = React.useRef<AbortController | null>(null);
	const dragDepth = React.useRef(0);

	React.useEffect(
		() => () => {
			activeUpload.current?.abort();
			activeUpload.current = null;
		},
		[],
	);

	const upload = async (files: File[]) => {
		if (activeUpload.current) return;
		if (files.length !== 1) {
			setError(t`Drop one image at a time.`);
			return;
		}
		const file = files[0]!;
		if (!matchesMimeAllowlist(file.type, ["image/"])) {
			setError(t`Only image files can be dropped here.`);
			return;
		}
		if (allowedMimeTypes?.length && !matchesMimeAllowlist(file.type, allowedMimeTypes)) {
			setError(t`This field does not accept ${file.type} files.`);
			return;
		}

		const controller = new AbortController();
		activeUpload.current = controller;
		setUploading(true);
		setError(null);
		try {
			const item = await uploadMedia(file, { fieldId, signal: controller.signal });
			if (controller.signal.aborted || activeUpload.current !== controller) return;
			void queryClient.invalidateQueries({ queryKey: ["media"] });
			onUploaded(item);
		} catch (cause) {
			if (!controller.signal.aborted && activeUpload.current === controller) {
				setError(getMutationError(cause) ?? t`Image upload failed. Try again.`);
			}
		} finally {
			if (activeUpload.current === controller) {
				activeUpload.current = null;
				setUploading(false);
			}
		}
	};

	return (
		<div className={cn("grid gap-2", className)}>
			<div
				className={cn(
					"rounded-xl border-2 border-dashed border-kumo-line bg-kumo-control",
					dragActive && "border-kumo-brand bg-kumo-tint",
				)}
				aria-busy={uploading}
				onDragEnter={(event) => {
					if (!event.dataTransfer.types.includes("Files") || activeUpload.current) return;
					event.preventDefault();
					dragDepth.current += 1;
					setDragActive(true);
				}}
				onDragOver={(event) => {
					event.preventDefault();
					event.dataTransfer.dropEffect =
						event.dataTransfer.types.includes("Files") && !activeUpload.current ? "copy" : "none";
				}}
				onDragLeave={() => {
					dragDepth.current = Math.max(0, dragDepth.current - 1);
					if (dragDepth.current === 0) setDragActive(false);
				}}
				onDrop={(event) => {
					event.preventDefault();
					event.stopPropagation();
					dragDepth.current = 0;
					setDragActive(false);
					if (event.dataTransfer.types.includes("Files"))
						void upload([...event.dataTransfer.files]);
				}}
			>
				<Button
					type="button"
					variant="ghost"
					className="h-auto min-h-32 w-full flex-col items-center justify-center gap-3 rounded-[10px] px-4 py-5 text-center text-sm text-kumo-subtle"
					aria-label={t`Drop an image here or browse for ${label}`}
					disabled={uploading}
					onClick={() => {
						setError(null);
						onSelect();
					}}
				>
					{uploading ? (
						<Loader size="sm" aria-hidden="true" />
					) : (
						<UploadSimple className="h-8 w-8 shrink-0" aria-hidden="true" />
					)}
					<span className="font-normal">
						{uploading ? (
							t`Uploading image…`
						) : (
							<Trans>
								Drop an image here or{" "}
								<span className="font-medium text-kumo-default underline decoration-kumo-line decoration-2 underline-offset-4">
									browse
								</span>
							</Trans>
						)}
					</span>
				</Button>
			</div>
			<span role="status" className="sr-only">
				{uploading ? t`Uploading image…` : ""}
			</span>
			{error && (
				<p role="alert" className="text-sm text-kumo-danger">
					{error}
				</p>
			)}
		</div>
	);
}
