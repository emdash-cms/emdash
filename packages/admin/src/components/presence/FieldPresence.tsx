import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { useRoomPeers } from "../../lib/co-editing/hooks.js";
import type { RoomEditing } from "../../lib/co-editing/types.js";
import { cn } from "../../lib/utils.js";
import { useAfterFirstPaint, useLeavingItems } from "./presence-motion.js";

const MAX_PILLS = 2;

const ENTER =
	"transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none";

/**
 * The names of the people in a field, at the inline end of its label row. It floats over the
 * row, so the field never moves when someone arrives. The avatars in the bar say the same to a
 * screen reader, with the field's name.
 */
export function FieldPresence({ room, field }: { room: RoomEditing; field: string }) {
	const { t } = useLingui();
	const users = useRoomPeers(room, field);
	const visible = React.useMemo(() => users.slice(0, MAX_PILLS), [users]);
	const shown = useLeavingItems(visible);
	const animate = useAfterFirstPaint();
	const more = users.length - visible.length;
	if (shown.length === 0) return null;
	return (
		<div
			aria-hidden="true"
			className="pointer-events-none absolute end-0 top-0 flex h-lh max-w-[60%] items-center justify-end gap-1"
		>
			{shown.map(({ item: user, leaving }) => (
				<span
					key={user.id}
					dir="auto"
					data-author-color={user.color}
					className={cn(
						"emdash-presence-pill min-w-0 truncate",
						animate && ENTER,
						leaving && "opacity-0",
					)}
				>
					{user.name}
				</span>
			))}
			{more > 0 && (
				<span dir="ltr" data-author-color="neutral" className="emdash-presence-pill shrink-0">
					{t`+${more}`}
				</span>
			)}
		</div>
	);
}
