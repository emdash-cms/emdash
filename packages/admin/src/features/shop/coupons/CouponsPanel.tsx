import { Button, Dialog, Input, Loader, Select, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	createShopCoupon,
	deleteShopCoupon,
	fetchShopCoupons,
	type ShopCoupon,
	updateShopCoupon,
} from "../../../lib/api/index.js";

function money(value: number, symbol: string): string {
	return `${symbol} ${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

function LoadingState({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm text-kumo-subtle">
			<Loader />
			<span>{label}</span>
		</div>
	);
}

function ErrorState({ label }: { label: string }) {
	return (
		<p className="rounded-lg border border-kumo-danger p-6 text-sm text-kumo-danger">{label}</p>
	);
}

export function CouponsPanel() {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const queryClient = useQueryClient();
	const couponsQuery = useQuery({ queryKey: ["shop", "coupons"], queryFn: fetchShopCoupons });
	const [form, setForm] = React.useState({
		code: "",
		discountType: "percentage" as "percentage" | "fixed",
		discountValue: "",
		minimumSubtotal: "0",
		usageLimit: "",
	});
	const [editing, setEditing] = React.useState<ShopCoupon | null>(null);
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const saveMutation = useMutation({
		mutationFn: () => {
			const input = {
				code: form.code,
				discountType: form.discountType,
				discountValue: Number(form.discountValue),
				minimumSubtotal: Number(form.minimumSubtotal) || 0,
				usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
				active: true,
			};
			return editing ? updateShopCoupon(editing.id, input) : createShopCoupon(input);
		},
		onSuccess: () => {
			setForm({
				code: "",
				discountType: "percentage",
				discountValue: "",
				minimumSubtotal: "0",
				usageLimit: "",
			});
			setEditing(null);
			setDialogOpen(false);
			void queryClient.invalidateQueries({ queryKey: ["shop", "coupons"] });
			toastManager.add({ title: t`Coupon saved`, type: "success" });
		},
	});
	const deleteMutation = useMutation({
		mutationFn: deleteShopCoupon,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["shop", "coupons"] });
			toastManager.add({ title: t`Coupon deleted`, type: "success" });
		},
	});
	if (couponsQuery.isLoading) return <LoadingState label={t`Loading coupons`} />;
	if (couponsQuery.isError)
		return <ErrorState label={t`Could not load coupons. Please try again.`} />;
	const normalizedSearch = search.trim().toLowerCase();
	const coupons = (couponsQuery.data ?? []).filter(
		(coupon) => !normalizedSearch || coupon.code.toLowerCase().includes(normalizedSearch),
	);
	const openCreate = () => {
		setEditing(null);
		setForm({
			code: "",
			discountType: "percentage",
			discountValue: "",
			minimumSubtotal: "0",
			usageLimit: "",
		});
		setDialogOpen(true);
	};
	const openEdit = (coupon: ShopCoupon) => {
		setEditing(coupon);
		setForm({
			code: coupon.code,
			discountType: coupon.discountType,
			discountValue: String(coupon.discountValue),
			minimumSubtotal: String(coupon.minimumSubtotal),
			usageLimit: coupon.usageLimit === null ? "" : String(coupon.usageLimit),
		});
		setDialogOpen(true);
	};
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-[240px] flex-1">
					<Input
						label={t`Search coupons`}
						placeholder={t`Search by coupon code`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<Button icon={Plus} onClick={openCreate}>{t`New coupon`}</Button>
			</div>
			<div className="overflow-x-auto rounded-lg border border-kumo-line">
				<table className="w-full text-start">
					<thead className="border-b border-kumo-line bg-kumo-tint">
						<tr>
							<th className="p-3 text-start text-sm font-medium">{t`Code`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Discount`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Uses`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
						</tr>
					</thead>
					<tbody>
						{coupons.map((coupon) => (
							<tr
								key={coupon.id}
								className="border-b border-kumo-line last:border-0 hover:bg-kumo-tint"
							>
								<td className="p-3 font-medium">{coupon.code}</td>
								<td className="p-3">
									{coupon.discountType === "percentage"
										? `${coupon.discountValue}%`
										: money(coupon.discountValue, "")}
								</td>
								<td className="p-3 text-end">
									{coupon.usageLimit === null
										? t`Unlimited`
										: `${coupon.usageCount}/${coupon.usageLimit}`}
								</td>
								<td className="p-3 text-end">
									<div className="flex justify-end gap-2">
										<Button
											size="sm"
											variant="outline"
											onClick={() => openEdit(coupon)}
										>{t`Edit`}</Button>
										<Button
											size="sm"
											variant="ghost"
											onClick={() => deleteMutation.mutate(coupon.id)}
										>{t`Delete`}</Button>
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			{coupons.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">{t`No coupons match your search.`}</p>
			) : null}
			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog
					className="max-h-[90vh] w-[min(560px,calc(100vw-2rem))] overflow-y-auto p-6"
					size="lg"
				>
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">
							{editing ? t`Edit coupon` : t`New coupon`}
						</Dialog.Title>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button {...props} aria-label={t`Close`} variant="ghost" shape="square">
									×
								</Button>
							)}
						/>
					</div>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault();
							saveMutation.mutate();
						}}
					>
						<Input
							label={t`Code`}
							value={form.code}
							onChange={(event) => setForm({ ...form, code: event.target.value.toUpperCase() })}
							required
						/>
						<Select
							label={t`Discount type`}
							value={form.discountType}
							onValueChange={(value) =>
								(value === "percentage" || value === "fixed") &&
								setForm({ ...form, discountType: value })
							}
							items={{ percentage: t`Percentage`, fixed: t`Fixed amount` }}
						/>
						<Input
							label={form.discountType === "percentage" ? t`Percentage` : t`Amount`}
							type="number"
							min="0"
							value={form.discountValue}
							onChange={(event) => setForm({ ...form, discountValue: event.target.value })}
							required
						/>
						<Input
							label={t`Minimum subtotal`}
							type="number"
							min="0"
							value={form.minimumSubtotal}
							onChange={(event) => setForm({ ...form, minimumSubtotal: event.target.value })}
						/>
						<Input
							label={t`Usage limit`}
							type="number"
							min="1"
							value={form.usageLimit}
							onChange={(event) => setForm({ ...form, usageLimit: event.target.value })}
							placeholder={t`Unlimited`}
						/>
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDialogOpen(false)}
							>{t`Cancel`}</Button>
							<Button type="submit" disabled={saveMutation.isPending}>
								{saveMutation.isPending ? t`Saving...` : t`Save coupon`}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
