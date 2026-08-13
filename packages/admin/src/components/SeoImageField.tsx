/**
 * SEO OG Image field for the content editor.
 *
 * Renders an image picker (reusing MediaPickerModal) that stores the
 * selected image URL in `seo.image`. Designed to sit next to the
 * Featured Image field in a two-column grid.
 */

import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Image as ImageIcon, X } from "@phosphor-icons/react";
import * as React from "react";

import type { ContentSeo, ContentSeoInput, MediaItem } from "../lib/api";
import { FieldHelpLabel } from "./FieldHelpLabel.js";
import { MediaPickerModal } from "./MediaPickerModal";

export interface SeoImageFieldProps {
	seo?: ContentSeo;
	onChange: (seo: ContentSeoInput) => void;
}

export function SeoImageField({ seo, onChange }: SeoImageFieldProps) {
	const { t } = useLingui();
	const [pickerOpen, setPickerOpen] = React.useState(false);
	const imageUrl = seo?.image || null;

	const handleSelect = (item: MediaItem) => {
		const isLocalProvider = !item.provider || item.provider === "local";
		const url = isLocalProvider
			? `/_emdash/api/media/file/${item.storageKey || item.id}`
			: item.url;
		onChange({ image: url });
	};

	const handleRemove = () => {
		onChange({ image: null });
	};

	return (
		<div>
			<FieldHelpLabel
				help={t`Image shown when this page is shared on social media`}
				helpLabel={t`Why is this important for social sharing?`}
			>
				{t`OG Image`}
			</FieldHelpLabel>
			{imageUrl ? (
				<div className="mt-2 relative group">
					<img src={imageUrl} alt="" className="max-h-48 rounded-lg border object-cover" />
					<div className="absolute top-2 end-2 opacity-0 group-hover:opacity-100 transition-opacity flex gap-1">
						<Button type="button" size="sm" variant="secondary" onClick={() => setPickerOpen(true)}>
							{t`Change`}
						</Button>
						<Button
							type="button"
							shape="square"
							variant="destructive"
							className="h-8 w-8"
							onClick={handleRemove}
							aria-label={t`Remove image`}
						>
							<X className="h-4 w-4" />
						</Button>
					</div>
				</div>
			) : (
				<Button
					type="button"
					variant="outline"
					className="mt-2 h-32 w-full justify-center border-dashed"
					onClick={() => setPickerOpen(true)}
				>
					<div className="flex flex-col items-center gap-2 text-kumo-subtle">
						<ImageIcon className="h-8 w-8" />
						<span>{t`Select OG image`}</span>
					</div>
				</Button>
			)}
			<MediaPickerModal
				open={pickerOpen}
				onOpenChange={setPickerOpen}
				onSelect={handleSelect}
				mimeTypeFilter="image/"
				title={t`Select OG Image`}
			/>
		</div>
	);
}
