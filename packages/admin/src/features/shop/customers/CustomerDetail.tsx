import { Badge, Button } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";

import type { ShopCustomerSummary } from "../../../lib/api/index.js";

function formatStatus(status: string, t: (descriptor: MessageDescriptor) => string): string {
	const labels: Record<string, MessageDescriptor> = {
		new: msg`New`,
		confirmed: msg`Confirmed`,
		preparing: msg`Preparing`,
		ready: msg`Ready for delivery`,
		in_transit: msg`In transit`,
		delivered: msg`Delivered`,
		cancelled: msg`Cancelled`,
		not_delivered: msg`Not delivered`,
		rescheduled: msg`Rescheduled`,
		pending: msg`Pending`,
	};
	const label = labels[status];
	return label ? t(label) : status;
}

function money(value: number, symbol: string): string {
	return `${symbol} ${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

export function CustomerDetail({
	customer,
	currencySymbol,
	onCopy,
}: {
	customer: ShopCustomerSummary;
	currencySymbol: string;
	onCopy: (value: string) => void;
}) {
	const { t } = useLingui();
	const fields = [
		[t`Name`, customer.name],
		[t`Email`, customer.email],
		[t`Address`, customer.address],
		[t`District`, customer.district],
		[t`Reference`, customer.reference],
		[t`Notes`, customer.notes],
	] as const;
	return (
		<div className="space-y-5">
			<div className="flex flex-wrap gap-2">
				<Button
					size="sm"
					onClick={() =>
						window.open(
							`https://wa.me/${customer.phone.replace(/\D/g, "")}`,
							"_blank",
							"noopener,noreferrer",
						)
					}
				>{t`Open WhatsApp`}</Button>
				<Button
					size="sm"
					variant="outline"
					onClick={() => onCopy(customer.phone)}
				>{t`Copy phone`}</Button>
				{customer.address ? (
					<Button
						size="sm"
						variant="outline"
						onClick={() => onCopy(customer.address ?? "")}
					>{t`Copy address`}</Button>
				) : null}
			</div>
			<div className="rounded-lg border border-kumo-line p-4">
				<div className="flex flex-wrap justify-between gap-3">
					<div>
						<p className="text-sm text-kumo-subtle">{t`Orders`}</p>
						<p className="text-xl font-semibold">{customer.orderCount}</p>
					</div>
					<div className="text-end">
						<p className="text-sm text-kumo-subtle">{t`Total spent`}</p>
						<p className="text-xl font-semibold">{money(customer.totalSpent, currencySymbol)}</p>
					</div>
				</div>
			</div>
			<div className="grid gap-4 sm:grid-cols-2">
				<div className="rounded-lg border border-kumo-line p-3">
					<p className="text-sm text-kumo-subtle">{t`Phone`}</p>
					<p className="mt-1">{customer.phone}</p>
				</div>
				{fields.map(([label, value]) => (
					<div key={label} className="rounded-lg border border-kumo-line p-3">
						<p className="text-sm text-kumo-subtle">{label}</p>
						<p className="mt-1 whitespace-pre-wrap">{value || "—"}</p>
					</div>
				))}
			</div>
			<div>
				<h3 className="mb-2 font-medium">{t`Order history`}</h3>
				{customer.orders.length === 0 ? (
					<p className="text-sm text-kumo-subtle">{t`No orders yet.`}</p>
				) : (
					<div className="space-y-2">
						{customer.orders.map((order) => (
							<div
								key={order.orderNumber}
								className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-line p-3 text-sm"
							>
								<span className="font-medium">{order.orderNumber}</span>
								<Badge>{formatStatus(order.status, t)}</Badge>
								<span>{money(order.total, currencySymbol)}</span>
							</div>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
