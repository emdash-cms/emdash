import { Badge, DropdownMenu, LayerCard, Tooltip } from "@cloudflare/kumo";
import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Code, PencilSimple, Trash } from "@phosphor-icons/react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";

import { fetchMenu, type Menu } from "../lib/api";
import { ADMIN_NAV_ICONS } from "./admin-navigation-icons.js";
import { RowActionsMenu } from "./DataTable.js";
import { MenuNavPreview } from "./menus/MenuNavPreview.js";

interface MenuCardProps {
	menu: Menu;
	showLocale: boolean;
	onDelete: () => void;
}

/** True once the element has come within a screen of the viewport, so long lists load previews lazily. */
function useNearViewport<T extends Element>(): [React.RefObject<T | null>, boolean] {
	const ref = React.useRef<T>(null);
	const [near, setNear] = React.useState(false);
	React.useEffect(() => {
		const element = ref.current;
		if (!element || near) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setNear(true);
			},
			{ rootMargin: "100% 0px" },
		);
		observer.observe(element);
		return () => observer.disconnect();
	}, [near]);
	return [ref, near];
}

export function MenuCard({ menu, showLocale, onDelete }: MenuCardProps) {
	const { t } = useLingui();
	const navigate = useNavigate();
	const [ref, near] = useNearViewport<HTMLDivElement>();

	const { data } = useQuery({
		queryKey: ["menu", menu.name, menu.locale],
		queryFn: () => fetchMenu(menu.name, { locale: menu.locale }),
		enabled: near,
		staleTime: 60_000,
	});
	const linkProps = {
		to: "/menus/$name",
		params: { name: menu.name },
		search: { locale: menu.locale },
	} as const;

	return (
		<LayerCard className="group/card relative flex h-full min-w-0 flex-col overflow-hidden p-0 transition-shadow has-[a:focus-visible]:ring-2 has-[a:focus-visible]:ring-kumo-brand hover:shadow-md">
			<div ref={ref}>
				<MenuNavPreview items={data?.items} className="border-b border-kumo-line" />
			</div>
			<div className="flex min-w-0 items-start gap-2 px-4 py-3">
				<div className="min-w-0 flex-1">
					<h2 className="text-base leading-6 font-semibold">
						<Link
							{...linkProps}
							title={menu.label}
							className="line-clamp-2 break-words outline-none after:absolute after:inset-0 after:content-['']"
						>
							<bdi>{menu.label}</bdi>
						</Link>
					</h2>
					<div className="mt-1.5 flex min-w-0 items-center gap-3 text-xs leading-4 text-kumo-subtle">
						{menu.itemCount !== undefined && (
							<span className="flex shrink-0 items-center gap-1.5 whitespace-nowrap">
								<ADMIN_NAV_ICONS.menus
									size={14}
									className="text-kumo-inactive"
									aria-hidden="true"
								/>
								<span dir="auto" className="tabular-nums">
									{plural(menu.itemCount, { one: "# item", other: "# items" })}
								</span>
							</span>
						)}
						<Tooltip
							content={t`Themes load this menu with getMenu("${menu.name}")`}
							render={
								<span className="relative z-10 flex min-w-0 items-center gap-1.5">
									<Code size={14} className="shrink-0 text-kumo-inactive" aria-hidden="true" />
									<code dir="ltr" className="min-w-0 truncate font-mono text-xs leading-4">
										{menu.name}
									</code>
								</span>
							}
						/>
						{showLocale && (
							<Badge variant="outline" className="shrink-0 uppercase">
								<bdi dir="ltr">{menu.locale}</bdi>
							</Badge>
						)}
					</div>
				</div>
				<div className="relative z-10 -me-1.5 shrink-0">
					<RowActionsMenu label={t`Actions for ${menu.label}`}>
						<DropdownMenu.Item
							icon={<PencilSimple className="size-4" aria-hidden="true" />}
							onClick={() => void navigate(linkProps)}
						>
							{t`Edit`}
						</DropdownMenu.Item>
						<DropdownMenu.Separator />
						<DropdownMenu.Item
							variant="danger"
							icon={<Trash className="size-4" aria-hidden="true" />}
							onClick={onDelete}
						>
							{t`Delete`}
						</DropdownMenu.Item>
					</RowActionsMenu>
				</div>
			</div>
		</LayerCard>
	);
}
