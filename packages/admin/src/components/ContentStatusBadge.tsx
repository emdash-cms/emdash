import { Badge, type BadgeVariant } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import {
	Archive,
	ArrowsClockwise,
	CalendarDots,
	CheckCircle,
	CircleDashed,
	LockKey,
	type Icon,
} from "@phosphor-icons/react";

import { cn } from "../lib/utils";

export type ContentStatusState =
	| "published"
	| "draft"
	| "scheduled"
	| "archived"
	| "pendingChanges"
	| "private";

export const CONTENT_STATUS_ICONS: Record<ContentStatusState, Icon> = {
	published: CheckCircle,
	draft: CircleDashed,
	scheduled: CalendarDots,
	archived: Archive,
	pendingChanges: ArrowsClockwise,
	private: LockKey,
};

export const CONTENT_STATUS_ICON_COLORS: Record<ContentStatusState, string> = {
	published: "text-kumo-success",
	draft: "text-kumo-warning",
	scheduled: "text-kumo-info",
	archived: "text-kumo-subtle",
	pendingChanges: "text-kumo-warning",
	private: "text-kumo-subtle",
};

export function isContentStatusState(status: string): status is ContentStatusState {
	return Object.hasOwn(CONTENT_STATUS_ICONS, status);
}

const CONTENT_STATUS_VARIANTS: Record<ContentStatusState, BadgeVariant> = {
	published: "success",
	draft: "warning",
	scheduled: "info",
	archived: "neutral",
	pendingChanges: "warning",
	private: "secondary",
};

function useContentStatusLabel(state: ContentStatusState): string {
	const { t } = useLingui();

	switch (state) {
		case "published":
			return t`Published`;
		case "draft":
			return t`Draft`;
		case "scheduled":
			return t`Scheduled`;
		case "archived":
			return t`Archived`;
		case "pendingChanges":
			return t`Pending changes`;
		case "private":
			return t`Private`;
	}
}

export interface ContentStatusProps {
	state: ContentStatusState;
	className?: string;
}

export function ContentStatusLabel({ state, className }: ContentStatusProps) {
	const label = useContentStatusLabel(state);
	const Icon = CONTENT_STATUS_ICONS[state];

	return (
		<span className={cn("inline-flex items-center gap-1.5", className)}>
			<Icon className={cn("h-3.5 w-3.5", CONTENT_STATUS_ICON_COLORS[state])} aria-hidden="true" />
			{label}
		</span>
	);
}

export function ContentStatusBadge({ state, className }: ContentStatusProps) {
	const label = useContentStatusLabel(state);
	const Icon = CONTENT_STATUS_ICONS[state];

	return (
		<Badge variant={CONTENT_STATUS_VARIANTS[state]} className={cn("gap-1.5", className)}>
			<Icon className="h-3 w-3" aria-hidden="true" />
			{label}
		</Badge>
	);
}

export interface ContentStatusIconProps extends ContentStatusProps {
	decorative?: boolean;
}

export function ContentStatusIcon({
	state,
	className,
	decorative = false,
}: ContentStatusIconProps) {
	const label = useContentStatusLabel(state);
	const Icon = CONTENT_STATUS_ICONS[state];

	return decorative ? (
		<Icon
			className={cn("h-3.5 w-3.5", CONTENT_STATUS_ICON_COLORS[state], className)}
			aria-hidden="true"
		/>
	) : (
		<Icon
			className={cn("h-3.5 w-3.5", CONTENT_STATUS_ICON_COLORS[state], className)}
			role="img"
			aria-label={label}
		/>
	);
}
