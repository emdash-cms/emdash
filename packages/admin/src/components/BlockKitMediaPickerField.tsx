import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, ImageBroken, ImageSquare, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../lib/api";
import { localMediaFileUrl } from "../lib/media-utils.js";
import { isSafeUrl } from "../lib/url";
import { MediaPickerModal } from "./MediaPickerModal";

export interface BlockKitMediaPickerFieldProps {
	actionId: string;
	label: string;
	placeholder?: string;
	mimeTypeFilter?: string;
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
}

interface SelectedMediaCardProps {
	broken: boolean;
	label: string;
	url: string;
	onError: () => void;
	onRemove: () => void;
	onReplace: () => void;
}

function mediaFilename(url: string): string {
	try {
		const pathname = new URL(url, "https://emdash.local").pathname;
		const encodedFilename = pathname.split("/").findLast(Boolean);
		if (!encodedFilename) return url;
		try {
			return decodeURIComponent(encodedFilename);
		} catch {
			return encodedFilename;
		}
	} catch {
		return url;
	}
}

function SelectedMediaCard({
	broken,
	label,
	url,
	onError,
	onRemove,
	onReplace,
}: SelectedMediaCardProps) {
	const { t } = useLingui();

	return (
		<LayerCard className="grid w-full grid-cols-[5rem_minmax(0,1fr)] items-center rounded-xl p-0">
			<div className="m-2 h-16 overflow-hidden rounded-lg bg-kumo-tint ring ring-kumo-line">
				{broken ? (
					<div className="flex h-full items-center justify-center text-kumo-subtle">
						<ImageBroken className="size-5" aria-hidden="true" />
					</div>
				) : (
					<img
						src={url}
						alt=""
						className="emdash-media-transparency-grid size-full object-contain"
						referrerPolicy="no-referrer"
						loading="lazy"
						onError={onError}
					/>
				)}
			</div>
			<div className="flex min-w-0 flex-col gap-2 px-2 py-2 pe-3">
				<Text as="p" bold truncate>
					<bdi dir="auto">{mediaFilename(url)}</bdi>
				</Text>
				{broken && (
					<Text as="p" variant="secondary" size="xs">
						{t`Image not found`}
					</Text>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						type="button"
						size="sm"
						variant="secondary"
						icon={<ImageSquare aria-hidden="true" />}
						onClick={onReplace}
						aria-label={t`Replace ${label}`}
					>
						{t`Replace`}
					</Button>
					<Button
						type="button"
						size="sm"
						variant="secondary-destructive"
						icon={<X aria-hidden="true" />}
						onClick={onRemove}
						aria-label={t`Remove ${label}`}
					>
						{t`Remove`}
					</Button>
				</div>
			</div>
		</LayerCard>
	);
}

/**
 * Shared media_picker BlockKit element renderer used by `BlockKitFieldWidget`
 * (sandboxed plugin field widgets) and the `BlockKitField` switch inside
 * `PortableTextEditor` (plugin block forms).
 *
 * The stored value is the asset URL string, so values are interchangeable
 * with `text_input`. Existing arbitrary URLs are tolerated but only previewed
 * when they pass scheme/path safety checks.
 */
export function BlockKitMediaPickerField({
	actionId,
	label,
	placeholder,
	mimeTypeFilter,
	value,
	onChange,
}: BlockKitMediaPickerFieldProps) {
	const { t } = useLingui();
	const labelId = React.useId();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [imageBroken, setImageBroken] = React.useState(false);
	const url = typeof value === "string" && value.length > 0 ? value : "";

	React.useEffect(() => {
		setImageBroken(false);
	}, [url]);
	const filter = mimeTypeFilter ?? "image/";
	const canPreview = isSafePreviewUrl(url);

	const handleSelect = (item: MediaItem) => {
		// `MediaPickerModal` returns URL-inserted items with `id: ""` and no
		// `provider`/`storageKey`, so we cannot infer "local" from absence of
		// `provider` alone — that would rewrite the external URL to a broken
		// `/_emdash/api/media/file/` path. Detect local explicitly.
		const isLocalMedia = item.provider === "local" || !!item.storageKey;
		const localKey = item.storageKey || item.id;
		const nextUrl = isLocalMedia && localKey ? localMediaFileUrl(localKey) : item.url;
		if (!nextUrl) return;
		onChange(actionId, nextUrl);
	};

	return (
		<div role="group" aria-labelledby={labelId}>
			<span id={labelId} className="mb-1.5 block text-sm font-medium text-kumo-default">
				{label}
			</span>
			{canPreview ? (
				<SelectedMediaCard
					broken={imageBroken}
					label={label}
					url={url}
					onError={() => setImageBroken(true)}
					onReplace={() => setPickerOpen(true)}
					onRemove={() => onChange(actionId, "")}
				/>
			) : (
				<Button
					type="button"
					variant="outline"
					className="h-24 w-full justify-center rounded-xl border-dashed bg-kumo-control"
					onClick={() => setPickerOpen(true)}
				>
					<div className="flex flex-col items-center gap-1.5 text-kumo-subtle">
						<ImageIcon className="size-6" aria-hidden="true" />
						<span className="text-sm">{placeholder ?? t`Select media`}</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilter={filter}
				title={canPreview ? t`Replace ${label}` : t`Select ${label}`}
				confirmLabel={canPreview ? t`Replace` : undefined}
			/>
		</div>
	);
}

const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/**
 * Returns true when `url` is safe to preview via `<img src={url}>`:
 * - Same-origin relative path starting with `/` (but not `//`)
 * - External `http://` or `https://` URL
 *
 * Rejects `javascript:`, `data:`, protocol-relative `//host`, and other
 * schemes whose preview could leak credentials or trigger surprises.
 */
function isSafePreviewUrl(url: string): boolean {
	if (!url) return false;
	if (HAS_SCHEME_RE.test(url)) {
		return isSafeUrl(url);
	}
	return url.startsWith("/") && !url.startsWith("//");
}
