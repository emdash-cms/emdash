import { Badge } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { ArrowSquareOut } from "@phosphor-icons/react";
import * as React from "react";

import type { MenuItem } from "../../lib/api";
import { cn } from "../../lib/utils.js";
import {
	kindIcon,
	useMenuItemTarget,
	useProblemLabels,
	type MenuItemProblem,
	type MenuItemTarget,
} from "./menu-item-target.js";
import { INDENT_WIDTH } from "./menu-tree.js";

export const ROW_CLASS = "relative flex h-11 items-center gap-1 pe-2 ps-1.5";

export function ProblemBadge({ problem }: { problem: MenuItemProblem }) {
	const labels = useProblemLabels();
	return (
		<Badge
			variant={problem === "draft" ? "warning" : "error"}
			className="shrink-0 whitespace-nowrap"
		>
			<span className="hidden @xl/menu-items:inline">{labels.long[problem]}</span>
			<span className="@xl/menu-items:hidden">{labels.short[problem]}</span>
		</Badge>
	);
}

export function MenuItemKindIcon({
	target,
	className,
}: {
	target: Pick<MenuItemTarget, "kind" | "hierarchical">;
	className?: string;
}) {
	const Icon = kindIcon(target.kind, target.hierarchical);
	return <Icon className={cn("size-4 shrink-0 text-kumo-subtle", className)} aria-hidden="true" />;
}

/** The muted text after a row's label: the URL, entry path, term, or "Heading". */
function MenuItemDestination({ target }: { target: MenuItemTarget }) {
	const { t } = useLingui();
	return (
		<>
			{target.destination &&
				(target.destinationIsUrl ? (
					<bdi dir="ltr" title={target.destination} className="min-w-0 truncate text-kumo-subtle">
						{target.destination}
					</bdi>
				) : (
					<span title={target.destination} className="min-w-0 truncate text-kumo-subtle">
						{target.destination}
					</span>
				))}
			{target.opensInNewTab && (
				<ArrowSquareOut
					className="size-3.5 shrink-0 text-kumo-subtle"
					role="img"
					aria-label={t`Opens in a new tab`}
				/>
			)}
		</>
	);
}

/**
 * One menu row's contents after the handle: the kind icon, label, destination,
 * any problem badge, and `actions` at the end. `onEdit` makes the whole row a
 * press target for editing, under the handle and the actions.
 */
export function MenuItemRowBody({
	item,
	depth,
	locale,
	actions,
	onEdit,
}: {
	item: MenuItem;
	depth: number;
	locale?: string;
	actions?: React.ReactNode;
	onEdit?: () => void;
}) {
	const target = useMenuItemTarget(item, locale);
	return (
		<>
			<div
				className="flex min-w-0 flex-1 items-center gap-2.5 text-base transition-[padding] duration-150 ease-out motion-reduce:transition-none"
				style={{ paddingInlineStart: depth * INDENT_WIDTH }}
			>
				<MenuItemKindIcon target={target} />
				{onEdit ? (
					<button
						type="button"
						onClick={onEdit}
						title={item.label}
						className="min-w-0 truncate rounded-sm text-start outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-kumo-brand focus-visible:after:-outline-offset-2"
					>
						<bdi>{item.label}</bdi>
					</button>
				) : (
					<span className="min-w-0 truncate">
						<bdi>{item.label}</bdi>
					</span>
				)}
				<span className="@container/destination min-w-0 flex-1">
					<span className="flex items-center gap-1.5 @max-[4rem]/destination:hidden">
						<MenuItemDestination target={target} />
					</span>
				</span>
			</div>
			{target.problem && <ProblemBadge problem={target.problem} />}
			{actions && <div className="relative z-10 flex shrink-0 items-center">{actions}</div>}
		</>
	);
}
