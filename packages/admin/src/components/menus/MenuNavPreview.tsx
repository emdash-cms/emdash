import { CaretDown, Plus } from "@phosphor-icons/react";
import * as React from "react";

import type { MenuItem } from "../../lib/api/menus.js";
import { cn } from "../../lib/utils.js";
import { LogoMarkMono } from "../Logo.js";

const SKELETON_WIDTHS = ["w-9", "w-12", "w-8", "w-11"];

interface MenuNavPreviewProps {
	/** The menu's items; `undefined` while they load. */
	items: MenuItem[] | undefined;
	className?: string;
}

/**
 * A small picture of a site, with a header drawn from the menu's top-level
 * items, so a menu is recognisable at a glance. Purely decorative: the card
 * names the menu.
 */
export function MenuNavPreview({ items, className }: MenuNavPreviewProps) {
	const ids = React.useMemo(() => new Set(items?.map((item) => item.id)), [items]);
	const topLevel = React.useMemo(
		() =>
			(items ?? [])
				.filter((item) => item.parentId === null || !ids.has(item.parentId))
				.sort((a, b) => a.sortOrder - b.sortOrder),
		[items, ids],
	);
	const parents = React.useMemo(
		() => new Set((items ?? []).map((item) => item.parentId).filter(Boolean)),
		[items],
	);

	return (
		<div
			aria-hidden="true"
			className={cn(
				"relative h-32 overflow-hidden bg-kumo-recessed select-none [contain-intrinsic-size:auto_8rem] [content-visibility:auto]",
				className,
			)}
		>
			<div className="absolute inset-0 [background-image:radial-gradient(var(--color-kumo-line)_1px,transparent_1px)] [background-size:12px_12px] [background-position:6px_6px] mask-b-from-20%" />

			<div className="absolute inset-x-5 top-5 -bottom-6 overflow-hidden rounded-lg bg-kumo-base shadow-[0_1px_2px_var(--color-kumo-shadow-drop),0_12px_24px_-12px_var(--color-kumo-shadow-drop)] transition-transform duration-200 ease-(--ease-emdash) group-hover/card:-translate-y-1 motion-reduce:transition-none">
				<span className="pointer-events-none absolute inset-0 z-10 rounded-lg ring ring-kumo-line ring-inset mask-b-from-25% mask-b-to-55%" />
				<div className="flex h-9 items-center gap-3 border-b border-kumo-hairline ps-3 pe-2">
					<LogoMarkMono className="size-3.5 shrink-0 text-kumo-inactive" />
					<div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden mask-r-from-80% rtl:mask-r-from-100% rtl:mask-l-from-80%">
						{items === undefined ? (
							SKELETON_WIDTHS.map((width) => (
								<span
									key={width}
									className={cn("mx-1.5 h-1.5 shrink-0 rounded-full bg-kumo-contrast/10", width)}
								/>
							))
						) : topLevel.length === 0 ? (
							<span className="ms-1 flex h-6 w-20 shrink-0 items-center justify-center rounded-md text-kumo-subtle outline-1 -outline-offset-1 outline-dashed outline-kumo-interact">
								<Plus size={10} weight="bold" />
							</span>
						) : (
							topLevel.map((item, index) => (
								<span
									key={item.id}
									dir="auto"
									className={cn(
										"flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs leading-4 whitespace-nowrap",
										index === 0 ? "bg-kumo-tint font-medium text-kumo-strong" : "text-kumo-subtle",
									)}
								>
									{item.label}
									{parents.has(item.id) && (
										<CaretDown size={9} weight="bold" className="opacity-60" />
									)}
								</span>
							))
						)}
					</div>
				</div>

				<div className="px-4 pt-3">
					<span className="block h-2 w-2/5 rounded-full bg-kumo-contrast/15" />
					<span className="mt-2 block h-1.5 w-3/4 rounded-full bg-kumo-contrast/8" />
					<span className="mt-1.5 block h-1.5 w-1/2 rounded-full bg-kumo-contrast/8" />
					<div className="mt-3 grid grid-cols-3 gap-2">
						<span className="h-10 rounded-md bg-kumo-contrast/5 ring ring-kumo-hairline" />
						<span className="h-10 rounded-md bg-kumo-contrast/5 ring ring-kumo-hairline" />
						<span className="h-10 rounded-md bg-kumo-contrast/5 ring ring-kumo-hairline" />
					</div>
				</div>
			</div>

			<div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 overflow-hidden rounded-b-[inherit] *:rounded-b-[inherit]">
				<div className="absolute inset-0 backdrop-blur-[1px] [mask-image:linear-gradient(to_bottom,transparent_0%,black_25%,black_50%,transparent_75%)]" />
				<div className="absolute inset-0 backdrop-blur-[3px] [mask-image:linear-gradient(to_bottom,transparent_25%,black_50%,black_75%,transparent_100%)]" />
				<div className="absolute inset-0 backdrop-blur-[6px] [mask-image:linear-gradient(to_bottom,transparent_50%,black_75%,black_100%)]" />
				<div className="absolute inset-0 bg-linear-to-b from-transparent from-20% via-kumo-recessed/45 to-kumo-recessed" />
			</div>
		</div>
	);
}
