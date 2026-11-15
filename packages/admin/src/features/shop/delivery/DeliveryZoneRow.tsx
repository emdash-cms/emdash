import { Badge, Button } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Trash } from "@phosphor-icons/react";

import type { ShopDeliveryZone } from "../../../lib/api/index.js";

function money(value: number, symbol: string): string {
	return `${symbol} ${new Intl.NumberFormat(undefined, {
		minimumFractionDigits: 2,
		maximumFractionDigits: 2,
	}).format(value)}`;
}

export function DeliveryZoneRow({
	zone,
	currencySymbol,
	onDelete,
	onEdit,
}: {
	zone: ShopDeliveryZone;
	currencySymbol: string;
	onDelete: () => void;
	onEdit: () => void;
}) {
	const { t } = useLingui();

	return (
		<tr className="border-b border-kumo-line last:border-0 hover:bg-kumo-tint">
			<td className="p-3 font-medium">{zone.name}</td>
			<td className="max-w-[320px] p-3 text-sm text-kumo-subtle">{zone.districts.join(", ")}</td>
			<td className="p-3 text-end font-medium">{money(zone.deliveryCost, currencySymbol)}</td>
			<td className="p-3 text-sm">{zone.estimatedTime ?? "—"}</td>
			<td className="p-3">
				<Badge variant={zone.active ? "success" : "secondary"}>
					{zone.active ? t`Active` : t`Inactive`}
				</Badge>
			</td>
			<td className="p-3 text-end">
				<div className="flex justify-end gap-2">
					<Button size="sm" variant="outline" onClick={onEdit}>
						{t`Edit`}
					</Button>
					<Button
						variant="ghost"
						shape="square"
						aria-label={t`Delete ${zone.name}`}
						onClick={onDelete}
					>
						<Trash className="text-kumo-danger" />
					</Button>
				</div>
			</td>
		</tr>
	);
}
