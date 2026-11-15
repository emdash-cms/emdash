import { Button, Dialog, Input, Loader, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import { fetchShopOrder, fetchShopOrders } from "../../../lib/api/index.js";
import { OrderDetailPanel } from "./OrderDetailPanel.js";
import { OrderRow } from "./OrderRow.js";

export function OrdersPanel() {
	const { t } = useLingui();
	const ordersQuery = useQuery({ queryKey: ["shop", "orders"], queryFn: fetchShopOrders });
	const [selectedId, setSelectedId] = React.useState<string | null>(null);
	const [search, setSearch] = React.useState("");
	const [statusFilter, setStatusFilter] = React.useState("all");
	const detailQuery = useQuery({
		queryKey: ["shop", "order", selectedId],
		queryFn: () => fetchShopOrder(selectedId ?? ""),
		enabled: selectedId !== null,
	});

	if (ordersQuery.isLoading) return <LoadingState label={t`Loading orders`} />;
	const orders = (ordersQuery.data ?? []).filter((order) => {
		const matchesSearch =
			!search.trim() || order.orderNumber.toLowerCase().includes(search.trim().toLowerCase());
		const matchesStatus =
			statusFilter === "all" ||
			order.status === statusFilter ||
			order.paymentStatus === statusFilter ||
			order.deliveryStatus === statusFilter;
		return matchesSearch && matchesStatus;
	});
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-[240px] flex-1">
					<Input
						label={t`Search orders`}
						placeholder={t`Search by order number`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<div className="min-w-[200px]">
					<Select
						aria-label={t`Filter orders by status`}
						value={statusFilter}
						onValueChange={(value) => value && setStatusFilter(value)}
						items={{
							all: t`All statuses`,
							new: t`New`,
							confirmed: t`Confirmed`,
							preparing: t`Preparing`,
							ready: t`Ready for delivery`,
							in_transit: t`In transit`,
							delivered: t`Delivered`,
							cancelled: t`Cancelled`,
							pending: t`Pending`,
							not_delivered: t`Not delivered`,
							rescheduled: t`Rescheduled`,
						}}
					/>
				</div>
			</div>
			<div className="overflow-x-auto rounded-lg border border-kumo-line">
				<table className="w-full text-start">
					<thead className="border-b border-kumo-line bg-kumo-tint">
						<tr>
							<th className="p-3 text-start text-sm font-medium">{t`Order`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Status`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Payment`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Delivery`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Total`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
						</tr>
					</thead>
					<tbody>
						{orders.map((order) => (
							<OrderRow key={order.id} order={order} onClick={() => setSelectedId(order.id)} />
						))}
					</tbody>
				</table>
			</div>
			{orders.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">{t`No orders match your filters.`}</p>
			) : null}
			<Dialog.Root open={selectedId !== null} onOpenChange={(open) => !open && setSelectedId(null)}>
				<Dialog
					className="max-h-[90vh] w-[min(960px,calc(100vw-2rem))] overflow-y-auto p-6"
					size="lg"
				>
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">{t`Order details`}</Dialog.Title>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button {...props} aria-label={t`Close`} variant="ghost" shape="square">
									×
								</Button>
							)}
						/>
					</div>
					{detailQuery.isLoading ? (
						<LoadingState label={t`Loading order details`} />
					) : detailQuery.data ? (
						<OrderDetailPanel order={detailQuery.data} />
					) : (
						<p className="text-sm text-kumo-subtle">{t`Order details unavailable.`}</p>
					)}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}

function LoadingState({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm text-kumo-subtle">
			<Loader />
			<span>{label}</span>
		</div>
	);
}
