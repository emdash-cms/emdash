import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, X } from "@phosphor-icons/react";
import * as React from "react";

import type { MediaItem } from "../lib/api";
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
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const url = typeof value === "string" && value.length > 0 ? value : "";
	const filter = mimeTypeFilter ?? "image/";
	const canPreview = isSafePreviewUrl(url);

	const handleSelect = (item: MediaItem) => {
		// `MediaPickerModal` returns URL-inserted items with `id: ""` and no
		// `provider`/`storageKey`, so we cannot infer "local" from absence of
		// `provider` alone — that would rewrite the external URL to a broken
		// `/_emdash/api/media/file/` path. Detect local explicitly.
		const isLocalMedia = item.provider === "local" || !!item.storageKey;
		const localKey = item.storageKey || item.id;
		const nextUrl = isLocalMedia && localKey ? `/_emdash/api/media/file/${localKey}` : item.url;
		if (!nextUrl) return;
		onChange(actionId, nextUrl);
	};

	return (
		<div>
			<label className="text-sm font-medium mb-1.5 block">{label}</label>
			{canPreview ? (
				<div className="relative group">
					<img
						src={url}
						alt=""
						className="max-h-40 w-full rounded-md border border-kumo-line object-contain bg-kumo-muted"
						referrerPolicy="no-referrer"
						loading="lazy"
					/>
					<div className="absolute top-2 end-2 opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto transition-opacity flex gap-1">
						<Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
							{t`Change`}
						</Button>
						<Button
							type="button"
							shape="square"
							variant="destructive"
							className="h-8 w-8"
							onClick={() => onChange(actionId, "")}
							aria-label={t`Remove`}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					className="w-full h-24 border-dashed"
					onClick={() => setPickerOpen(true)}
				>
					<div className="flex flex-col items-center gap-1.5 text-kumo-subtle">
						<ImageIcon className="h-6 w-6" />
						<span className="text-sm">{placeholder ?? t`Select media`}</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilter={filter}
				title={t`Select ${label}`}
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
