import { Badge, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { ShopOrderSummary } from "../../../lib/api/index.js";
import { formatStatus, money } from "./helpers.js";

export function OrderRow({ order, onClick }: { order: ShopOrderSummary; onClick: () => void }) {
	const { t } = useLingui();
	return (
		<tr className="border-b border-kumo-line last:border-0 hover:bg-kumo-tint">
			<td className="p-3 font-medium">{order.orderNumber}</td>
			<td className="p-3">
				<Badge>{formatStatus(order.status, t)}</Badge>
			</td>
			<td className="p-3">
				<Badge variant={order.paymentStatus === "confirmed" ? "success" : "secondary"}>
					{formatStatus(order.paymentStatus, t)}
				</Badge>
			</td>
			<td className="p-3">
				<Badge variant="secondary">{formatStatus(order.deliveryStatus, t)}</Badge>
			</td>
			<td className="p-3 text-end font-medium">{money(order.total, order.currencySymbol)}</td>
			<td className="p-3 text-end">
				<Button size="sm" variant="outline" onClick={onClick}>{t`View details`}</Button>
			</td>
		</tr>
	);
}
