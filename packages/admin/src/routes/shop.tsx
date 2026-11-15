import { BookingsPanel } from "../features/shop/bookings/index.js";
import { CouponsPanel } from "../features/shop/coupons/index.js";
import { CustomersPanel } from "../features/shop/customers/index.js";
import { DeliveryZonesPanel } from "../features/shop/delivery/index.js";
import { ShopShell } from "../features/shop/navigation/index.js";
import { OrdersPanel } from "../features/shop/orders/index.js";
import { ShopOverviewPage } from "../features/shop/overview/ShopOverviewPage.js";
import { ShopSettingsPanel } from "../features/shop/settings/index.js";

export function Shop() {
	return <ShopOverviewPage />;
}

export function ShopSettingsRoute() {
	return (
		<ShopShell activeSection="settings">
			<ShopSettingsPanel />
		</ShopShell>
	);
}

export function ShopDeliveryRoute() {
	return (
		<ShopShell activeSection="delivery">
			<DeliveryZonesPanel />
		</ShopShell>
	);
}

export function ShopOrdersRoute() {
	return (
		<ShopShell activeSection="orders">
			<OrdersPanel />
		</ShopShell>
	);
}

export function ShopCustomersRoute() {
	return (
		<ShopShell activeSection="customers">
			<CustomersPanel />
		</ShopShell>
	);
}

export function ShopCouponsRoute() {
	return (
		<ShopShell activeSection="coupons">
			<CouponsPanel />
		</ShopShell>
	);
}

export function ShopBookingsRoute() {
	return (
		<ShopShell activeSection="bookings">
			<BookingsPanel />
		</ShopShell>
	);
}
