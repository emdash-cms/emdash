import { Badge, Button, LayerCard } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Pencil, Trash } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";

import type { Menu } from "../lib/api/menus.js";
import { RouterLinkButton } from "./RouterLinkButton.js";

interface MenuCardProps {
	menu: Menu;
	showLocale: boolean;
	onDelete: () => void;
}

export function MenuCard({ menu, showLocale, onDelete }: MenuCardProps) {
	const { t } = useLingui();

	return (
		<LayerCard className="flex h-full min-w-0 flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
			<Link
				to="/menus/$name"
				params={{ name: menu.name }}
				search={{ locale: menu.locale }}
				className="group min-w-0 flex-1 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-brand"
			>
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<h2
						dir="auto"
						className="min-w-0 break-words text-base font-semibold leading-6 group-hover:underline"
					>
						{menu.label}
					</h2>
					{showLocale && (
						<Badge variant="outline" className="shrink-0 uppercase">
							<bdi dir="ltr">{menu.locale}</bdi>
						</Badge>
					)}
				</div>
				<div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-kumo-subtle">
					<code dir="ltr" className="max-w-full truncate text-xs" title={menu.name}>
						{menu.name}
					</code>
					<span aria-hidden="true">·</span>
					<span className="tabular-nums">
						{plural(menu.itemCount ?? 0, { one: "# item", other: "# items" })}
					</span>
				</div>
			</Link>
			<div className="flex shrink-0 items-center justify-end gap-2">
				<RouterLinkButton
					to="/menus/$name"
					params={{ name: menu.name }}
					search={{ locale: menu.locale }}
					variant="secondary"
					size="base"
					icon={<Pencil size={16} aria-hidden="true" />}
				>
					{t`Edit`}
				</RouterLinkButton>
				<Button
					variant="secondary"
					shape="square"
					size="base"
					icon={<Trash size={16} aria-hidden="true" />}
					aria-label={t`Delete ${menu.name} menu`}
					onClick={onDelete}
				/>
			</div>
		</LayerCard>
	);
}
