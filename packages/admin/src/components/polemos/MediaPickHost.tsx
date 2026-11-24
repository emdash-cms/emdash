import * as React from "react";

import type { MediaItem } from "../../lib/api.js";
import { MediaPickerModal } from "../MediaPickerModal.js";

interface MediaPickDetail {
	onSelect?: (url: string) => void;
	mimeTypeFilter?: string;
	label?: string;
}

/**
 * Opens the article media library when a plugin form's media_picker asks for it.
 * Plugins dispatch `polemos-media-pick` on window.
 */
export function PolemosMediaPickHost() {
	const chooseRef = React.useRef<((url: string) => void) | null>(null);
	const [open, setOpen] = React.useState(false);
	const [filter, setFilter] = React.useState("image/");
	const [label, setLabel] = React.useState("");

	React.useEffect(() => {
		const onPick = (event: Event) => {
			const detail = (event as CustomEvent<MediaPickDetail>).detail;
			if (!detail || typeof detail.onSelect !== "function") return;
			chooseRef.current = detail.onSelect;
			setFilter(
				typeof detail.mimeTypeFilter === "string" && detail.mimeTypeFilter
					? detail.mimeTypeFilter
					: "image/",
			);
			setLabel(typeof detail.label === "string" ? detail.label : "");
			setOpen(true);
		};
		window.addEventListener("polemos-media-pick", onPick);
		return () => window.removeEventListener("polemos-media-pick", onPick);
	}, []);

	return (
		<MediaPickerModal
			open={open}
			onOpenChange={setOpen}
			mimeTypeFilter={filter}
			title={label || undefined}
			onSelect={(item: MediaItem) => {
				const choose = chooseRef.current;
				const isLocalMedia = item.provider === "local" || !!item.storageKey;
				const localKey = item.storageKey || item.id;
				const nextUrl =
					isLocalMedia && localKey ? `/_emdash/api/media/file/${localKey}` : item.url;
				if (choose && nextUrl) choose(nextUrl);
			}}
		/>
	);
}
