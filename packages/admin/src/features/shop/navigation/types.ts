import type { MessageDescriptor } from "@lingui/core";
import type * as React from "react";

export type ShopSection = "settings" | "delivery" | "orders" | "customers" | "coupons" | "bookings";

export interface ShopNavigationItem {
	section: ShopSection;
	label: MessageDescriptor;
	icon: React.ElementType;
	/** Optional route target for the route-backed version of shop navigation. */
	href?: string;
}

export interface ShopNavigationProps {
	activeSection?: ShopSection;
	items?: readonly ShopNavigationItem[];
	onSectionChange?: (section: ShopSection) => void;
	className?: string;
}

export interface ShopShellProps {
	children: React.ReactNode;
	activeSection?: ShopSection;
	items?: readonly ShopNavigationItem[];
	onSectionChange?: (section: ShopSection) => void;
	title?: MessageDescriptor;
	description?: MessageDescriptor;
}
