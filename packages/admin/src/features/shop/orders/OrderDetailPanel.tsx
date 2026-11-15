import { Badge, Button, Input, InputArea, Select, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { CheckCircle } from "@phosphor-icons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	confirmShopPayment,
	fetchShopOrderWhatsAppUrl,
	type ShopOrderDetail,
	updateShopDelivery,
} from "../../../lib/api/index.js";
import { formatStatus, money } from "./helpers.js";

export function OrderDetailPanel({ order }: { order: ShopOrderDetail }) {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const queryClient = useQueryClient();
	const paymentMutation = useMutation({
		mutationFn: () => confirmShopPayment(order.id),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["shop", "orders"] });
			void queryClient.invalidateQueries({ queryKey: ["shop", "order", order.id] });
			toastManager.add({ title: t`Payment confirmed`, type: "success" });
		},
	});
	const deliveryMutation = useMutation({
		mutationFn: ({ status, cancellationReason }: { status: string; cancellationReason?: string }) =>
			updateShopDelivery(order.id, {
				status,
				trackingCode: trackingCode || null,
				trackingUrl: trackingUrl || null,
				cancellationReason: cancellationReason || null,
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["shop", "orders"] });
			void queryClient.invalidateQueries({ queryKey: ["shop", "order", order.id] });
			toastManager.add({ title: t`Delivery updated`, type: "success" });
		},
	});
	const [trackingCode, setTrackingCode] = React.useState(
		typeof order.delivery.trackingCode === "string" ? order.delivery.trackingCode : "",
	);
	const [trackingUrl, setTrackingUrl] = React.useState(
		typeof order.delivery.trackingUrl === "string" ? order.delivery.trackingUrl : "",
	);
	const [pendingStatus, setPendingStatus] = React.useState<string | null>(null);
	const [cancellationReason, setCancellationReason] = React.useState("");
	const [templateKey, setTemplateKey] = React.useState(
		order.deliveryStatus === "delivered"
			? "delivered"
			: order.deliveryStatus === "in_transit"
				? "inTransit"
				: order.status === "preparing"
					? "preparing"
					: "orderReceived",
	);
	const whatsappWindowRef = React.useRef<Window | null>(null);
	const whatsappMutation = useMutation({
		mutationFn: () => fetchShopOrderWhatsAppUrl(order.id, templateKey),
		onSuccess: (url) => {
			if (!url.startsWith("https://wa.me/")) {
				whatsappWindowRef.current?.close();
				whatsappWindowRef.current = null;
				return;
			}
			if (whatsappWindowRef.current) {
				whatsappWindowRef.current.location.href = url;
				whatsappWindowRef.current = null;
			} else {
				window.open(url, "_blank", "noopener,noreferrer");
			}
		},
	});
	const customerName = typeof order.customer.name === "string" ? order.customer.name : t`Customer`;
	const address = typeof order.delivery.address === "string" ? order.delivery.address : "";
	return (
		<div className="space-y-5 rounded-xl border border-kumo-line bg-kumo-base p-6">
			<div className="flex flex-wrap items-start justify-between gap-4">
				<div>
					<p className="text-sm text-kumo-subtle">{t`Order`}</p>
					<h2 className="text-xl font-semibold">{order.orderNumber}</h2>
				</div>
				<div className="text-end">
					<p className="text-sm text-kumo-subtle">{t`Total`}</p>
					<span className="text-xl font-semibold">{money(order.total, order.currencySymbol)}</span>
				</div>
			</div>
			<div className="rounded-lg bg-kumo-tint p-4">
				<p className="font-medium">{customerName}</p>
				<p className="text-sm text-kumo-subtle">{address}</p>
			</div>
			<div className="space-y-2 rounded-lg border border-kumo-line p-4">
				<p className="text-sm font-medium">{t`Products`}</p>
				{order.items.map((item) => (
					<div key={item.id} className="flex justify-between gap-3 text-sm">
						<span>
							{item.productName} × {item.quantity}
						</span>
						<span>{money(item.subtotal, order.currencySymbol)}</span>
					</div>
				))}
			</div>
			<div className="grid gap-3 sm:grid-cols-2">
				<div className="rounded-lg border border-kumo-line p-3">
					<p className="mb-2 text-sm text-kumo-subtle">{t`Payment status`}</p>
					<Badge variant={order.paymentStatus === "confirmed" ? "success" : "secondary"}>
						{formatStatus(order.paymentStatus, t)}
					</Badge>
					{order.paymentStatus !== "confirmed" ? (
						<div className="mt-3 space-y-2">
							<p className="text-xs text-kumo-subtle">{t`Press once to confirm the payment.`}</p>
							<Button
								size="sm"
								icon={<CheckCircle />}
								onClick={() => paymentMutation.mutate()}
								disabled={paymentMutation.isPending}
							>
								{paymentMutation.isPending ? t`Confirming...` : t`Confirm payment`}
							</Button>
						</div>
					) : null}
				</div>
				<div className="rounded-lg border border-kumo-line p-3">
					<p className="mb-2 text-sm text-kumo-subtle">{t`Delivery status`}</p>
					<Badge variant={order.deliveryStatus === "delivered" ? "success" : "secondary"}>
						{formatStatus(order.deliveryStatus, t)}
					</Badge>
					<div className="mt-3">
						<Select
							aria-label={t`Update delivery status`}
							value={order.deliveryStatus}
							onValueChange={(value) => {
								if (value === "cancelled") {
									setPendingStatus(value);
									return;
								}
								if (value) deliveryMutation.mutate({ status: value });
							}}
							items={{
								pending: t`Pending`,
								assigned: t`Assigned`,
								preparing: t`Preparing`,
								in_transit: t`In transit`,
								delivered: t`Delivered`,
								not_delivered: t`Not delivered`,
								rescheduled: t`Rescheduled`,
								cancelled: t`Cancelled`,
							}}
						/>
					</div>
				</div>
			</div>
			{pendingStatus === "cancelled" ? (
				<div className="space-y-2 rounded-lg border border-kumo-line p-3">
					<InputArea
						label={t`Cancellation reason`}
						value={cancellationReason}
						onChange={(event) => setCancellationReason(event.target.value)}
						placeholder={t`Explain why this order is being cancelled`}
						rows={3}
						required
					/>
					<div className="flex justify-end gap-2">
						<Button type="button" variant="ghost" onClick={() => setPendingStatus(null)}>
							{t`Cancel`}
						</Button>
						<Button
							type="button"
							disabled={!cancellationReason.trim() || deliveryMutation.isPending}
							onClick={() => {
								deliveryMutation.mutate({
									status: "cancelled",
									cancellationReason: cancellationReason.trim(),
								});
								setPendingStatus(null);
							}}
						>
							{t`Confirm cancellation`}
						</Button>
					</div>
				</div>
			) : null}
			<div className="grid gap-4 sm:grid-cols-2">
				<Input
					label={t`Tracking code (optional)`}
					value={trackingCode}
					onChange={(event) => setTrackingCode(event.target.value)}
					placeholder={t`Code from delivery provider`}
				/>
				<Input
					label={t`Tracking URL (optional)`}
					type="url"
					value={trackingUrl}
					onChange={(event) => setTrackingUrl(event.target.value)}
					placeholder="https://delivery.example/track/..."
				/>
			</div>
			<div className="space-y-3 rounded-lg border border-kumo-line p-4">
				<div>
					<p className="font-medium">{t`WhatsApp message`}</p>
					<p className="text-sm text-kumo-subtle">{t`Choose a template, review it in WhatsApp, and send it manually.`}</p>
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<div className="min-w-[240px] flex-1">
						<Select
							label={t`Message template`}
							value={templateKey}
							onValueChange={(value) => value && setTemplateKey(value)}
							items={{
								orderReceived: t`Order received`,
								paymentConfirmed: t`Payment confirmed`,
								preparing: t`Preparing`,
								inTransit: t`In transit`,
								delivered: t`Delivered`,
								cancelled: t`Cancelled`,
							}}
						/>
					</div>
					<Button
						type="button"
						disabled={whatsappMutation.isPending}
						onClick={() => {
							const whatsappWindow = window.open("about:blank", "_blank");
							if (whatsappWindow) whatsappWindow.opener = null;
							whatsappWindowRef.current = whatsappWindow;
							whatsappMutation.mutate();
						}}
					>
						{whatsappMutation.isPending ? t`Opening...` : t`Open WhatsApp`}
					</Button>
				</div>
			</div>
		</div>
	);
}
