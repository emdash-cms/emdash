import { msg } from "@lingui/core/macro";
import { CalendarBlank, Gear, ShoppingCart, Ticket, Truck, Users } from "@phosphor-icons/react";

import type { ShopNavigationItem } from "./types.js";

/**
 * Default labels and icons are route-independent so the existing `/shop`
 * page can adopt this navigation before child routes are introduced.
 */
export const SHOP_NAVIGATION_ITEMS = [
	{ section: "settings", label: msg`Store settings`, icon: Gear, href: "/shop/settings" },
	{ section: "delivery", label: msg`Delivery zones`, icon: Truck, href: "/shop/delivery" },
	{ section: "orders", label: msg`Orders`, icon: ShoppingCart, href: "/shop/orders" },
	{ section: "customers", label: msg`Customers`, icon: Users, href: "/shop/customers" },
	{ section: "coupons", label: msg`Coupons`, icon: Ticket, href: "/shop/coupons" },
	{ section: "bookings", label: msg`Bookings`, icon: CalendarBlank, href: "/shop/bookings" },
] satisfies readonly ShopNavigationItem[];
