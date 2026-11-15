import { Badge, LinkButton } from "@cloudflare/kumo";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import {
	ArrowSquareOut,
	Calendar,
	CheckCircle,
	Gear,
	MapPin,
	ShoppingCart,
	Tag,
} from "@phosphor-icons/react";

import { RouterLinkButton } from "../../../components/RouterLinkButton.js";

const sections = [
	{
		to: "/shop/orders",
		label: msg`Orders`,
		description: msg`Review payments, delivery, and order status.`,
		icon: ShoppingCart,
	},
	{
		to: "/shop/delivery",
		label: msg`Delivery`,
		description: msg`Manage zones, costs, and delivery availability.`,
		icon: MapPin,
	},
	{
		to: "/shop/coupons",
		label: msg`Coupons`,
		description: msg`Create and validate promotions for checkout.`,
		icon: Tag,
	},
	{
		to: "/shop/bookings",
		label: msg`Bookings`,
		description: msg`Manage scheduled bookings and open enrollments.`,
		icon: Calendar,
	},
	{
		to: "/shop/settings",
		label: msg`Store settings`,
		description: msg`Configure WhatsApp, payments, and checkout.`,
		icon: Gear,
	},
] as const;

export function ShopOverviewPage() {
	const { t } = useLingui();

	return (
		<div className="space-y-6">
			<div>
				<div className="flex flex-wrap items-center gap-2">
					<h1 className="text-2xl font-semibold leading-tight">{t`Ecommerce`}</h1>
					<Badge variant="success">{t`Active`}</Badge>
				</div>
				<p className="mt-1 max-w-2xl text-sm text-kumo-subtle">
					{t`Manage your store operations from one place.`}
				</p>
			</div>

			<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
				{sections.map(({ to, label, description, icon: Icon }) => (
					<RouterLinkButton
						key={to}
						to={to}
						variant="outline"
						className="h-auto min-h-32 flex-col items-start justify-start gap-3 p-4 text-start"
					>
						<Icon size={24} aria-hidden="true" />
						<span>
							<span className="block font-medium">{t(label)}</span>
							<span className="mt-1 block text-sm font-normal text-kumo-subtle">
								{t(description)}
							</span>
						</span>
					</RouterLinkButton>
				))}
			</div>

			<div className="rounded-lg border border-kumo-line p-4">
				<div className="flex flex-wrap items-start justify-between gap-4">
					<div className="flex gap-3">
						<CheckCircle size={24} className="mt-0.5 text-kumo-success" aria-hidden="true" />
						<div>
							<h2 className="font-semibold">{t`Public store verification`}</h2>
							<p className="mt-1 max-w-2xl text-sm text-kumo-subtle">
								{t`Use the public store to verify the cart, checkout, WhatsApp order flow, coupons, and order tracking.`}
							</p>
						</div>
					</div>
					<LinkButton href="/shop" icon={<ArrowSquareOut />}>
						{t`Open public store`}
					</LinkButton>
				</div>
			</div>
		</div>
	);
}
