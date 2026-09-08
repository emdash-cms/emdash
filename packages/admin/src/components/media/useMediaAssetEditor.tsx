import { useLingui } from "@lingui/react/macro";
import { useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	ApiResponseError,
	fetchMediaItem,
	type LocalMediaItem,
	type MediaItem,
} from "../../lib/api.js";
import { useCurrentUser } from "../../lib/api/current-user.js";
import { MediaDetailPanel } from "../MediaDetailPanel.js";

const ROLE_AUTHOR = 30;
const ROLE_EDITOR = 40;
const EMPTY_ITEM: MediaItem = {
	id: "",
	filename: "",
	mimeType: "application/octet-stream",
	url: "",
	size: 0,
	createdAt: "",
	provider: "content-placeholder",
};

export function useMediaAssetEditor(onItemChanged: (item: LocalMediaItem) => void) {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const currentUserQuery = useCurrentUser();
	const [item, setItem] = React.useState<LocalMediaItem | null>(null);
	const [open, setOpen] = React.useState(false);
	const [isOpening, setIsOpening] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);
	const requestRef = React.useRef<AbortController | null>(null);
	const triggerRef = React.useRef<HTMLElement | null>(null);

	React.useEffect(
		() => () => {
			requestRef.current?.abort();
			requestRef.current = null;
		},
		[],
	);

	const openAssetEditor = async (mediaId: string, trigger?: HTMLElement | null) => {
		requestRef.current?.abort();
		const request = new AbortController();
		requestRef.current = request;
		triggerRef.current = trigger ?? null;
		setError(null);
		setIsOpening(true);
		try {
			const [fetchedMedia, userResult] = await Promise.all([
				fetchMediaItem(mediaId, { signal: request.signal }),
				currentUserQuery.data ? Promise.resolve(currentUserQuery) : currentUserQuery.refetch(),
			]);
			if (request.signal.aborted) return;
			const media = fetchedMedia.url
				? fetchedMedia
				: {
						...fetchedMedia,
						url: `/_emdash/api/media/file/${encodeURIComponent(fetchedMedia.storageKey)}`,
					};
			const user = userResult.data;
			const canEdit =
				user &&
				(user.role >= ROLE_EDITOR || (user.role >= ROLE_AUTHOR && media.authorId === user.id));
			if (!media.mimeType.startsWith("image/") || !canEdit) {
				setError(t`You do not have permission to edit this asset.`);
				return;
			}
			setItem(media);
			setOpen(true);
		} catch (cause) {
			if (request.signal.aborted) return;
			if (cause instanceof ApiResponseError && (cause.status === 401 || cause.status === 403)) {
				void queryClient.resetQueries({ queryKey: ["currentUser"], exact: true });
				setError(t`You do not have permission to edit this asset.`);
			} else if (cause instanceof ApiResponseError && cause.code === "NOT_FOUND") {
				setError(t`This media item no longer exists.`);
			} else {
				setError(t`This media item could not be loaded. Try again.`);
			}
		} finally {
			if (requestRef.current === request) setIsOpening(false);
		}
	};

	const handleItemChanged = (nextItem: LocalMediaItem) => {
		setItem(nextItem);
		queryClient.setQueryData(["media", nextItem.id], nextItem);
		onItemChanged(nextItem);
	};

	const dialog = (
		<MediaDetailPanel
			open={open && item !== null}
			item={item ?? EMPTY_ITEM}
			context="content"
			canCropOriginal
			canDuplicateCrop
			restoreFocusTargetRef={triggerRef}
			onClose={() => setOpen(false)}
			onClosed={() => triggerRef.current?.focus({ preventScroll: true })}
			onItemRefreshed={handleItemChanged}
			onCroppedCopyCreated={handleItemChanged}
		/>
	);

	return { dialog, error, isActive: open || isOpening, isOpening, openAssetEditor };
}
