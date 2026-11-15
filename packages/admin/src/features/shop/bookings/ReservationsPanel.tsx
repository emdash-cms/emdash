import { Button, Dialog, Select } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchShopOrder,
	fetchShopReservations,
	type ShopReservationSummary,
	updateShopReservation,
} from "../../../lib/api/index.js";
import { formatStatus, LoadingState, money } from "./helpers.js";

export function ReservationsPanel() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [status, setStatus] = React.useState("all");
	const reservationsQuery = useQuery({
		queryKey: ["shop", "reservations", status],
		queryFn: () => fetchShopReservations(status),
	});
	const [selectedReservation, setSelectedReservation] =
		React.useState<ShopReservationSummary | null>(null);
	const orderDetailQuery = useQuery({
		queryKey: ["shop", "reservation-order", selectedReservation?.orderId],
		queryFn: () => fetchShopOrder(selectedReservation?.orderId ?? ""),
		enabled: selectedReservation?.orderId !== null && selectedReservation?.orderId !== undefined,
	});
	const updateMutation = useMutation({
		mutationFn: ({ id, nextStatus }: { id: string; nextStatus: string }) =>
			updateShopReservation(id, nextStatus),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["shop", "reservations"] }),
	});
	const reservations = reservationsQuery.data ?? [];
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 className="text-xl font-semibold">{t`Reservations`}</h2>
					<p className="mt-1 text-sm text-kumo-subtle">{t`Review and update service bookings.`}</p>
				</div>
				<Select
					aria-label={t`Filter reservations by status`}
					value={status}
					onValueChange={(value) => value && setStatus(value)}
					items={{
						all: t`All statuses`,
						held: t`Held`,
						pending_payment: t`Pending payment`,
						confirmed: t`Confirmed`,
						cancelled: t`Cancelled`,
						completed: t`Completed`,
						no_show: t`No show`,
					}}
				/>
			</div>
			{reservationsQuery.isLoading ? <LoadingState label={t`Loading reservations`} /> : null}
			{!reservationsQuery.isLoading && reservations.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">{t`No reservations found.`}</p>
			) : null}
			{reservations.length > 0 ? (
				<div className="overflow-x-auto rounded-lg border border-kumo-line">
					<table className="w-full text-start">
						<thead className="border-b border-kumo-line bg-kumo-tint">
							<tr>
								<th className="p-3 text-start text-sm font-medium">{t`Service`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Customer`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Date and time`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Status`}</th>
								<th className="p-3 text-end text-sm font-medium">{t`Order`}</th>
								<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
							</tr>
						</thead>
						<tbody>
							{reservations.map((reservation) => (
								<tr key={reservation.id} className="border-b border-kumo-line last:border-0">
									<td className="p-3 font-medium">
										{reservation.serviceName ?? reservation.serviceId}
									</td>
									<td className="p-3">{reservation.customerName ?? t`Customer`}</td>
									<td className="p-3 text-sm">
										{new Intl.DateTimeFormat(undefined, {
											dateStyle: "medium",
											timeStyle: "short",
											timeZone: "UTC",
										}).format(new Date(reservation.startsAt))}
									</td>
									<td className="p-3">
										<Select
											aria-label={t`Update reservation status`}
											value={reservation.status}
											onValueChange={(nextStatus) =>
												nextStatus && updateMutation.mutate({ id: reservation.id, nextStatus })
											}
											items={{
												held: t`Held`,
												pending_payment: t`Pending payment`,
												confirmed: t`Confirmed`,
												cancelled: t`Cancelled`,
												expired: t`Expired`,
												completed: t`Completed`,
												no_show: t`No show`,
											}}
										/>
									</td>
									<td className="p-3 text-end">{reservation.orderId ?? "—"}</td>
									<td className="p-3 text-end">
										<div className="flex flex-wrap justify-end gap-2">
											<Button
												type="button"
												size="sm"
												variant="outline"
												onClick={() => setSelectedReservation(reservation)}
											>
												{t`View details`}
											</Button>
											{!["cancelled", "expired", "completed", "no_show"].includes(
												reservation.status,
											) ? (
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={updateMutation.isPending}
													onClick={() =>
														updateMutation.mutate({ id: reservation.id, nextStatus: "cancelled" })
													}
												>
													{t`Cancel`}
												</Button>
											) : null}
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			<Dialog.Root
				open={selectedReservation !== null}
				onOpenChange={(open) => !open && setSelectedReservation(null)}
			>
				<Dialog
					className="max-h-[90vh] w-[min(640px,calc(100vw-2rem))] overflow-y-auto p-6"
					size="lg"
				>
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">{t`Reservation details`}</Dialog.Title>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button {...props} aria-label={t`Close`} variant="ghost" shape="square">
									×
								</Button>
							)}
						/>
					</div>
					{selectedReservation ? (
						<div className="grid gap-3 sm:grid-cols-2">
							{(
								[
									[t`Service`, selectedReservation.serviceName ?? selectedReservation.serviceId],
									[t`Customer`, selectedReservation.customerName ?? t`Customer`],
									[
										t`Starts at`,
										new Intl.DateTimeFormat(undefined, {
											dateStyle: "medium",
											timeStyle: "short",
											timeZone: "UTC",
										}).format(new Date(selectedReservation.startsAt)),
									],
									[
										t`Ends at`,
										new Intl.DateTimeFormat(undefined, {
											dateStyle: "medium",
											timeStyle: "short",
											timeZone: "UTC",
										}).format(new Date(selectedReservation.endsAt)),
									],
									[t`Status`, formatStatus(selectedReservation.status, t)],
									[t`Order`, selectedReservation.orderId ?? "—"],
								] as const
							).map(([label, value]) => (
								<div key={label} className="rounded-lg border border-kumo-line p-3">
									<p className="text-sm text-kumo-subtle">{label}</p>
									<p className="mt-1">{value}</p>
								</div>
							))}
							{selectedReservation.orderId ? (
								<div className="mt-4 sm:col-span-2">
									<h3 className="mb-2 font-medium">{t`Products in the order`}</h3>
									{orderDetailQuery.isLoading ? (
										<LoadingState label={t`Loading order details`} />
									) : null}
									{orderDetailQuery.data ? (
										<div className="space-y-2">
											{orderDetailQuery.data.items.map((item) => (
												<div
													key={item.id}
													className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-kumo-line p-3 text-sm"
												>
													<div>
														<p className="font-medium">{item.productName}</p>
														{item.variantName ? (
															<p className="text-kumo-subtle">{item.variantName}</p>
														) : null}
													</div>
													<span>
														{item.quantity} ×{" "}
														{money(item.unitPrice, orderDetailQuery.data.currencySymbol)} ={" "}
														{money(item.subtotal, orderDetailQuery.data.currencySymbol)}
													</span>
												</div>
											))}
										</div>
									) : null}
									{orderDetailQuery.data ? (
										<div className="mt-4">
											<h3 className="mb-2 font-medium">{t`Customer details`}</h3>
											<div className="grid gap-3 sm:grid-cols-2">
												{(
													[
														[t`Name`, orderDetailQuery.data.customer.name],
														[t`Phone`, orderDetailQuery.data.customer.phone],
														[t`Email`, orderDetailQuery.data.customer.email],
														[t`Address`, orderDetailQuery.data.customer.address],
														[t`District`, orderDetailQuery.data.customer.district],
														[t`Reference`, orderDetailQuery.data.customer.reference],
													] as const
												)
													.filter(
														([, value]) => value !== null && value !== undefined && value !== "",
													)
													.map(([label, value]) => (
														<div key={label} className="rounded-lg border border-kumo-line p-3">
															<p className="text-sm text-kumo-subtle">{label}</p>
															<p className="mt-1 break-words">{String(value)}</p>
														</div>
													))}
											</div>
										</div>
									) : null}
								</div>
							) : null}
						</div>
					) : null}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
