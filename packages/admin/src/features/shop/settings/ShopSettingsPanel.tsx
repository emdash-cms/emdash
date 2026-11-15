import { Button, Input, InputArea, Label, Loader, Select, Switch, Toast } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchShopSettings,
	type ShopSettings,
	type ShopSettingsUpdateInput,
	updateShopSettings,
} from "../../../lib/api/index.js";

const PAYMENT_METHODS = ["whatsapp", "yape", "plin", "bank_transfer", "cash_on_delivery"] as const;

export function ShopSettingsPanel() {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const queryClient = useQueryClient();
	const settingsQuery = useQuery({ queryKey: ["shop", "settings"], queryFn: fetchShopSettings });
	const [form, setForm] = React.useState<ShopSettings | null>(null);
	const [gatewaySecrets, setGatewaySecrets] = React.useState({ secretKey: "", webhookSecret: "" });

	React.useEffect(() => {
		if (settingsQuery.data) setForm(settingsQuery.data);
	}, [settingsQuery.data]);

	const saveMutation = useMutation({
		mutationFn: (input: ShopSettingsUpdateInput) => updateShopSettings(input),
		onSuccess: (settings) => {
			setForm(settings);
			setGatewaySecrets({ secretKey: "", webhookSecret: "" });
			void queryClient.invalidateQueries({ queryKey: ["shop", "settings"] });
			toastManager.add({ title: t`Store settings saved`, type: "success" });
		},
	});

	if (settingsQuery.isLoading || !form) return <LoadingState label={t`Loading store settings`} />;

	const togglePaymentMethod = (method: string, enabled: boolean) => {
		setForm((current) => {
			if (!current) return current;
			const paymentMethods = enabled
				? [...new Set([...current.paymentMethods, method])]
				: current.paymentMethods.filter((item) => item !== method);
			return { ...current, paymentMethods };
		});
	};

	return (
		<form
			className="max-w-5xl space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				saveMutation.mutate({
					...form,
					paymentGatewaySecretKey: gatewaySecrets.secretKey || undefined,
					paymentGatewayWebhookSecret: gatewaySecrets.webhookSecret || undefined,
				});
			}}
		>
			<div className="grid gap-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
				<Input
					label={t`Store name`}
					value={form.storeName}
					onChange={(e) => setForm({ ...form, storeName: e.target.value })}
					required
				/>
				<Input
					label={t`Currency`}
					value={form.currency}
					onChange={(e) => setForm({ ...form, currency: e.target.value.toUpperCase() })}
					maxLength={3}
					required
				/>
				<Input
					label={t`Currency symbol`}
					value={form.currencySymbol}
					onChange={(e) => setForm({ ...form, currencySymbol: e.target.value })}
					maxLength={8}
					placeholder={t`Example: S/`}
					required
				/>
			</div>
			<div className="max-w-3xl space-y-2">
				<Label>{t`WhatsApp number`}</Label>
				<Input
					value={form.whatsappNumber ?? ""}
					onChange={(e) => setForm({ ...form, whatsappNumber: e.target.value || null })}
					placeholder={t`Example: 51999999999`}
				/>
				<p className="text-sm text-kumo-subtle">{t`Use the country code without spaces or symbols.`}</p>
			</div>
			<div className="max-w-4xl space-y-3 rounded-lg border border-kumo-line p-4">
				<div>
					<h2 className="font-semibold">{t`WhatsApp order message`}</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t`The store name, order number, products, and total are added automatically.`}
					</p>
				</div>
				<InputArea
					label={t`Message introduction`}
					value={form.whatsappMessage ?? ""}
					onChange={(e) => setForm({ ...form, whatsappMessage: e.target.value || null })}
					rows={4}
					placeholder={t`Hello, I want to coordinate payment for my order.`}
				/>
				<InputArea
					label={t`Order received template`}
					value={form.whatsappTemplates.orderReceived ?? ""}
					onChange={(e) =>
						setForm({
							...form,
							whatsappTemplates: {
								...form.whatsappTemplates,
								orderReceived: e.target.value,
							},
						})
					}
					rows={3}
					placeholder={t`Optional message used when the customer sends the order to WhatsApp.`}
				/>
				<InputArea
					label={t`Payment confirmed template`}
					value={form.whatsappTemplates.paymentConfirmed ?? ""}
					onChange={(e) =>
						setForm({
							...form,
							whatsappTemplates: { ...form.whatsappTemplates, paymentConfirmed: e.target.value },
						})
					}
					rows={2}
				/>
				<InputArea
					label={t`Preparing template`}
					value={form.whatsappTemplates.preparing ?? ""}
					onChange={(e) =>
						setForm({
							...form,
							whatsappTemplates: { ...form.whatsappTemplates, preparing: e.target.value },
						})
					}
					rows={2}
				/>
				<InputArea
					label={t`In transit template`}
					value={form.whatsappTemplates.inTransit ?? ""}
					onChange={(e) =>
						setForm({
							...form,
							whatsappTemplates: { ...form.whatsappTemplates, inTransit: e.target.value },
						})
					}
					rows={2}
				/>
				<InputArea
					label={t`Delivered template`}
					value={form.whatsappTemplates.delivered ?? ""}
					onChange={(e) =>
						setForm({
							...form,
							whatsappTemplates: { ...form.whatsappTemplates, delivered: e.target.value },
						})
					}
					rows={2}
				/>
				<InputArea
					label={t`Cancelled template`}
					value={form.whatsappTemplates.cancelled ?? ""}
					onChange={(e) =>
						setForm({
							...form,
							whatsappTemplates: { ...form.whatsappTemplates, cancelled: e.target.value },
						})
					}
					rows={2}
				/>
				<div className="space-y-2">
					<Label>{t`Message preview`}</Label>
					<pre className="whitespace-pre-wrap rounded-lg bg-kumo-tint p-3 text-sm">
						{whatsappPreview(form, t)}
					</pre>
				</div>
			</div>
			<InputArea
				label={t`Payment instructions`}
				value={form.deliveryInstructions ?? ""}
				onChange={(e) => setForm({ ...form, deliveryInstructions: e.target.value || null })}
				rows={4}
				placeholder={t`Share your Yape, Plin, or bank transfer instructions.`}
			/>
			<InputArea
				label={t`Business hours`}
				value={form.businessHours ?? ""}
				onChange={(e) => setForm({ ...form, businessHours: e.target.value || null })}
				rows={3}
			/>
			<div className="rounded-lg border border-kumo-line p-4">
				<Switch
					label={t`Enable service bookings`}
					checked={form.bookingEnabled}
					onCheckedChange={(checked) => setForm({ ...form, bookingEnabled: Boolean(checked) })}
				/>
				<p className="mt-1 text-sm text-kumo-subtle">
					{t`Enable this store to offer services with scheduled bookings.`}
				</p>
			</div>
			<div className="grid gap-4 sm:grid-cols-3">
				<Input
					label={t`Preparation time`}
					value={form.preparationTime ?? ""}
					onChange={(e) => setForm({ ...form, preparationTime: e.target.value || null })}
					placeholder={t`Example: 24 hours`}
				/>
				<Input
					label={t`Minimum order subtotal`}
					type="number"
					min="0"
					value={form.minimumSubtotal}
					onChange={(e) => setForm({ ...form, minimumSubtotal: Number(e.target.value) || 0 })}
				/>
				<div className="space-y-3">
					<Switch
						checked={form.freeDeliveryMinSubtotal !== null}
						onCheckedChange={(enabled) =>
							setForm({
								...form,
								freeDeliveryMinSubtotal: enabled ? (form.freeDeliveryMinSubtotal ?? 0) : null,
							})
						}
						label={t`Enable free delivery`}
					/>
					{form.freeDeliveryMinSubtotal !== null ? (
						<Input
							label={t`Free delivery from subtotal`}
							type="number"
							min="0"
							value={form.freeDeliveryMinSubtotal}
							onChange={(e) =>
								setForm({
									...form,
									freeDeliveryMinSubtotal: Number(e.target.value) || 0,
								})
							}
						/>
					) : null}
				</div>
			</div>
			<div className="space-y-3">
				<Label>{t`Payment methods`}</Label>
				{PAYMENT_METHODS.map((method) => (
					<Switch
						key={method}
						label={paymentMethodLabel(method, t)}
						checked={form.paymentMethods.includes(method)}
						onCheckedChange={(checked) => togglePaymentMethod(method, checked)}
					/>
				))}
			</div>
			<div className="space-y-4 rounded-lg border border-kumo-line p-4">
				<div>
					<h2 className="font-semibold">{t`Payment gateway`}</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t`Save gateway parameters for a future integration. Orders continue through WhatsApp until a gateway connector is enabled.`}
					</p>
				</div>
				<Switch
					label={t`Enable payment gateway`}
					checked={Boolean(form.paymentGatewayEnabled)}
					onCheckedChange={(checked) =>
						setForm({ ...form, paymentGatewayEnabled: Boolean(checked) })
					}
				/>
				<div className="grid gap-4 sm:grid-cols-2">
					<Select
						label={t`Provider`}
						value={form.paymentGatewayProvider ?? "custom"}
						onValueChange={(value) =>
							value &&
							setForm({ ...form, paymentGatewayProvider: value === "custom" ? null : value })
						}
						items={{
							custom: t`Select later`,
							mercadopago: "Mercado Pago",
							culqi: "Culqi",
							stripe: "Stripe",
						}}
					/>
					<Select
						label={t`Environment`}
						value={form.paymentGatewayEnvironment}
						onValueChange={(value) =>
							value && setForm({ ...form, paymentGatewayEnvironment: value })
						}
						items={{ sandbox: t`Test mode`, production: t`Production` }}
					/>
				</div>
				<Input
					label={t`Public key`}
					value={form.paymentGatewayPublicKey ?? ""}
					onChange={(event) =>
						setForm({ ...form, paymentGatewayPublicKey: event.target.value || null })
					}
					placeholder={t`Public key from your provider`}
				/>
				<Input
					label={t`Secret key`}
					type="password"
					value={gatewaySecrets.secretKey}
					onChange={(event) =>
						setGatewaySecrets({ ...gatewaySecrets, secretKey: event.target.value })
					}
					placeholder={
						form.paymentGatewaySecretKeyConfigured
							? t`Secret key saved; enter a new one to replace it`
							: t`Secret key from your provider`
					}
				/>
				<Input
					label={t`Webhook secret`}
					type="password"
					value={gatewaySecrets.webhookSecret}
					onChange={(event) =>
						setGatewaySecrets({ ...gatewaySecrets, webhookSecret: event.target.value })
					}
					placeholder={
						form.paymentGatewayWebhookSecretConfigured
							? t`Webhook secret saved; enter a new one to replace it`
							: t`Webhook secret from your provider`
					}
				/>
				<Input
					label={t`Return URL`}
					value={form.paymentGatewayReturnUrl ?? ""}
					onChange={(event) =>
						setForm({ ...form, paymentGatewayReturnUrl: event.target.value || null })
					}
					placeholder={t`https://example.com/shop/payment-return`}
				/>
				<Input
					label={t`Webhook URL`}
					value={form.paymentGatewayWebhookUrl ?? ""}
					onChange={(event) =>
						setForm({ ...form, paymentGatewayWebhookUrl: event.target.value || null })
					}
					placeholder={t`https://example.com/_emdash/api/shop/payment-webhook`}
				/>
			</div>
			<div className="flex justify-end">
				<Button type="submit" disabled={saveMutation.isPending}>
					{saveMutation.isPending ? t`Saving...` : t`Save settings`}
				</Button>
			</div>
		</form>
	);
}

function whatsappPreview(
	settings: ShopSettings,
	t: (descriptor: MessageDescriptor) => string,
): string {
	return [
		settings.whatsappMessage || t(msg`Hello, I want to coordinate payment for my order.`),
		settings.storeName ? `${t(msg`Store`)}: ${settings.storeName}` : null,
		`${t(msg`Order`)}: #ABC12345-TEST`,
		`- ${t(msg`Sample product`)} x1: ${settings.currencySymbol} 35.00`,
		`${t(msg`Total`)}: ${settings.currencySymbol} 35.00`,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
}

function paymentMethodLabel(method: string, t: (descriptor: MessageDescriptor) => string): string {
	const labels: Record<string, MessageDescriptor> = {
		whatsapp: msg`Coordinate by WhatsApp`,
		yape: msg`Yape`,
		plin: msg`Plin`,
		bank_transfer: msg`Bank transfer`,
		cash_on_delivery: msg`Cash on delivery`,
	};
	return labels[method] ? t(labels[method]) : method;
}

function LoadingState({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm text-kumo-subtle">
			<Loader />
			<span>{label}</span>
		</div>
	);
}
