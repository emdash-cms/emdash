import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import * as React from "react";

import { SHOP_NAVIGATION_ITEMS } from "./items.js";
import { ShopNavigation } from "./ShopNavigation.js";
import type { ShopShellProps } from "./types.js";

const shopTitle = msg`Ecommerce`;
const shopDescription = msg`Manage your products, delivery settings, and orders.`;

export function ShopShell({
	children,
	activeSection = "settings",
	items = SHOP_NAVIGATION_ITEMS,
	onSectionChange,
	title = shopTitle,
	description = shopDescription,
}: ShopShellProps) {
	const { t } = useLingui();
	const titleId = React.useId();

	return (
		<div className="space-y-6">
			<header>
				<h1 id={titleId} className="text-2xl font-semibold leading-tight">
					{t(title)}
				</h1>
				<p className="mt-1 text-sm text-kumo-subtle">{t(description)}</p>
			</header>
			<ShopNavigation
				activeSection={activeSection}
				items={items}
				onSectionChange={onSectionChange}
			/>
			<div aria-labelledby={titleId}>{children}</div>
		</div>
	);
}
