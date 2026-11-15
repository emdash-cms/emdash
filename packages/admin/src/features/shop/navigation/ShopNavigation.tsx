import { Button, LinkButton } from "@cloudflare/kumo";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { SHOP_NAVIGATION_ITEMS } from "./items.js";
import type { ShopNavigationProps } from "./types.js";

const navigationLabel = msg`Ecommerce sections`;

export function ShopNavigation({
	activeSection = "settings",
	items = SHOP_NAVIGATION_ITEMS,
	onSectionChange,
	className,
}: ShopNavigationProps) {
	const { t } = useLingui();

	return (
		<nav aria-label={t(navigationLabel)} className={className}>
			<div className="flex flex-wrap gap-2 border-b border-kumo-line">
				{items.map((item) => {
					const isActive = activeSection === item.section;
					const Icon = item.icon;
					const icon = <Icon aria-hidden="true" size={16} />;

					if (item.href) {
						return (
							<LinkButton
								key={item.section}
								href={item.href}
								variant={isActive ? "secondary" : "ghost"}
								aria-current={isActive ? "page" : undefined}
								icon={icon}
							>
								{t(item.label)}
							</LinkButton>
						);
					}

					return (
						<Button
							key={item.section}
							type="button"
							variant={isActive ? "secondary" : "ghost"}
							aria-pressed={isActive}
							icon={icon}
							onClick={() => onSectionChange?.(item.section)}
						>
							{t(item.label)}
						</Button>
					);
				})}
			</div>
		</nav>
	);
}
