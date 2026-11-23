import { Button, LayerCard, Text } from "@cloudflare/kumo";
import { darkVariantActionId } from "@emdash-cms/blocks";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, ImageBroken, ImageSquare, Moon, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../lib/api";
import { isLocalMediaFileUrl, localMediaFileUrl } from "../lib/media-utils.js";
import { isSafeUrl } from "../lib/url";
import { cn } from "../lib/utils.js";
import { MediaPickerModal } from "./MediaPickerModal";

export interface BlockKitMediaPickerFieldProps {
	actionId: string;
	label: string;
	placeholder?: string;
	mimeTypeFilter?: string;
	/** Match the labels of the fields around it: Kumo fields use `base`. */
	labelSize?: "sm" | "base";
	value: unknown;
	onChange: (actionId: string, value: unknown) => void;
	/** Offer a second slot, stored under `${actionId}_dark`, for a dark color scheme. */
	darkVariant?: boolean;
	darkValue?: unknown;
	/** Apply several value changes at once; falls back to sequential `onChange` calls. */
	onChangeMany?: (patch: Record<string, unknown>) => void;
}

interface SelectedMediaCardProps {
	broken: boolean;
	label: string;
	/** Replaces the default "Selected image" title. */
	heading?: string;
	url: string;
	onError: () => void;
	onRemove: () => void;
	onReplace: () => void;
}

const FILE_EXTENSION_RE = /\.[a-z0-9]{1,8}$/i;

/** Image provider URLs often end in a variant such as `w=400,fit=scale-down`, not a filename. */
function mediaFilename(url: string): string | undefined {
	let segment: string | undefined;
	try {
		segment = new URL(url, "https://emdash.local").pathname.split("/").findLast(Boolean);
	} catch {
		return undefined;
	}
	if (!segment) return undefined;
	let filename = segment;
	try {
		filename = decodeURIComponent(segment);
	} catch {
		// Keep the encoded segment when it holds a malformed escape.
	}
	return FILE_EXTENSION_RE.test(filename) ? filename : undefined;
}

function SelectedMediaCard({
	broken,
	label,
	heading,
	url,
	onError,
	onRemove,
	onReplace,
}: SelectedMediaCardProps) {
	const { t } = useLingui();
	const title = heading || (!isLocalMediaFileUrl(url) && mediaFilename(url)) || t`Selected image`;

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
					<bdi dir="auto">{title}</bdi>
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
	labelSize = "base",
	value,
	onChange,
	darkVariant = false,
	darkValue,
	onChangeMany,
}: BlockKitMediaPickerFieldProps) {
	const { t } = useLingui();
	const labelId = React.useId();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const [pickerTarget, setPickerTarget] = React.useState<"image" | "darkVariant">("image");
	const [imageBroken, setImageBroken] = React.useState(false);
	const [darkImageBroken, setDarkImageBroken] = React.useState(false);
	const url = typeof value === "string" && value.length > 0 ? value : "";
	const darkUrl = typeof darkValue === "string" && darkValue.length > 0 ? darkValue : "";
	const darkKey = darkVariantActionId(actionId);
	const darkLabel = t`${label} (dark mode)`;

	React.useEffect(() => {
		setImageBroken(false);
	}, [url]);
	React.useEffect(() => {
		setDarkImageBroken(false);
	}, [darkUrl]);
	const filter = mimeTypeFilter ?? "image/";
	const canPreview = isSafePreviewUrl(url);
	const canPreviewDark = isSafePreviewUrl(darkUrl);
	const darkTarget = pickerTarget === "darkVariant";
	const showDarkSlot = darkVariant && canPreview;

	const openPicker = (target: "image" | "darkVariant") => {
		setPickerTarget(target);
		setPickerOpen(true);
	};

	const removePrimary = () => {
		if (darkVariant && darkUrl) {
			const patch = { [actionId]: "", [darkKey]: "" };
			if (onChangeMany) onChangeMany(patch);
			else {
				onChange(actionId, "");
				onChange(darkKey, "");
			}
			return;
		}
		onChange(actionId, "");
	};

	const handleSelect = (item: MediaItem) => {
		// `MediaPickerModal` returns URL-inserted items with `id: ""` and no
		// `provider`/`storageKey`, so we cannot infer "local" from absence of
		// `provider` alone — that would rewrite the external URL to a broken
		// `/_emdash/api/media/file/` path. Detect local explicitly.
		const isLocalMedia = item.provider === "local" || !!item.storageKey;
		const localKey = item.storageKey || item.id;
		const nextUrl = isLocalMedia && localKey ? localMediaFileUrl(localKey) : item.url;
		if (!nextUrl) return;
		onChange(darkTarget ? darkKey : actionId, nextUrl);
	};

	return (
		<div role="group" aria-labelledby={labelId}>
			<span
				id={labelId}
				className={cn(
					"mb-1.5 block font-medium text-kumo-default",
					labelSize === "sm" ? "text-sm" : "text-base",
				)}
			>
				{label}
			</span>
			{canPreview ? (
				<SelectedMediaCard
					broken={imageBroken}
					label={label}
					url={url}
					onError={() => setImageBroken(true)}
					onReplace={() => openPicker("image")}
					onRemove={removePrimary}
				/>
			) : (
				<Button
					type="button"
					variant="outline"
					className="h-24 w-full justify-center rounded-xl border-dashed bg-kumo-control"
					onClick={() => openPicker("image")}
				>
					<div className="flex flex-col items-center gap-1.5 text-kumo-subtle">
						<ImageIcon className="size-6" aria-hidden="true" />
						<span className="text-sm">{placeholder ?? t`Select media`}</span>
					</div>
				</Button>
			)}
			{showDarkSlot &&
				(canPreviewDark ? (
					<div className="mt-2">
						<SelectedMediaCard
							broken={darkImageBroken}
							label={darkLabel}
							heading={t`Dark mode variant`}
							url={darkUrl}
							onError={() => setDarkImageBroken(true)}
							onReplace={() => openPicker("darkVariant")}
							onRemove={() => onChange(darkKey, "")}
						/>
					</div>
				) : (
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="mt-2"
						icon={<Moon aria-hidden="true" />}
						onClick={() => openPicker("darkVariant")}
					>
						{t`Add dark mode variant`}
					</Button>
				))}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilter={filter}
				title={
					darkTarget
						? canPreviewDark
							? t`Replace ${darkLabel}`
							: t`Select ${darkLabel}`
						: canPreview
							? t`Replace ${label}`
							: t`Select ${label}`
				}
				confirmLabel={(darkTarget ? canPreviewDark : canPreview) ? t`Replace` : undefined}
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
