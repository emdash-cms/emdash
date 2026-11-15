import { Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";

import type { ShopCustomerSummary } from "../../../lib/api/index.js";

export function CustomerRow({
	customer,
	onClick,
}: {
	customer: ShopCustomerSummary;
	onClick: () => void;
}) {
	const { t } = useLingui();
	return (
		<tr className="border-b border-kumo-line last:border-0 hover:bg-kumo-tint">
			<td className="p-3 font-medium">{customer.name}</td>
			<td className="p-3">{customer.phone}</td>
			<td className="p-3">{customer.district ?? "—"}</td>
			<td className="p-3 text-end">{customer.orderCount}</td>
			<td className="p-3 text-end">{customer.lastOrderNumber ?? "—"}</td>
			<td className="p-3 text-end">
				<Button size="sm" variant="outline" onClick={onClick}>{t`View details`}</Button>
			</td>
		</tr>
	);
}
