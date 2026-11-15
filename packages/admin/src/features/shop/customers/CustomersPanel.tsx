import { Button, Dialog, Input, Loader, Select, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchShopCustomers,
	fetchShopSettings,
	type ShopCustomerSummary,
} from "../../../lib/api/index.js";
import { CustomerDetail } from "./CustomerDetail.js";
import { CustomerRow } from "./CustomerRow.js";

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

export function CustomersPanel() {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const customersQuery = useQuery({ queryKey: ["shop", "customers"], queryFn: fetchShopCustomers });
	const settingsQuery = useQuery({ queryKey: ["shop", "settings"], queryFn: fetchShopSettings });
	const [selectedCustomer, setSelectedCustomer] = React.useState<ShopCustomerSummary | null>(null);
	const [search, setSearch] = React.useState("");
	const [district, setDistrict] = React.useState("all");
	const [period, setPeriod] = React.useState("all");
	const [sort, setSort] = React.useState("recent");

	if (customersQuery.isLoading || settingsQuery.isLoading)
		return <LoadingState label={t`Loading customers`} />;
	if (customersQuery.isError || settingsQuery.isError)
		return <ErrorState label={t`Could not load customers. Please try again.`} />;

	const normalizedSearch = search.trim().toLowerCase();
	const districts = [
		...new Set(
			(customersQuery.data ?? [])
				.map((customer) => customer.district)
				.filter((value): value is string => Boolean(value)),
		),
	].toSorted();
	const periodStart =
		period === "30"
			? Date.now() - 30 * 24 * 60 * 60 * 1000
			: period === "90"
				? Date.now() - 90 * 24 * 60 * 60 * 1000
				: null;
	const customers = (customersQuery.data ?? [])
		.filter((customer) => {
			if (!normalizedSearch) return true;
			return [
				customer.name,
				customer.phone,
				customer.email,
				customer.district,
				customer.lastOrderNumber,
			].some((value) => value?.toLowerCase().includes(normalizedSearch));
		})
		.filter((customer) => district === "all" || customer.district === district)
		.filter(
			(customer) =>
				periodStart === null || new Date(customer.createdAt ?? 0).getTime() >= periodStart,
		)
		.toSorted((a, b) =>
			sort === "orders"
				? b.orderCount - a.orderCount
				: new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime(),
		);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-[240px] flex-1">
					<Input
						label={t`Search customers`}
						placeholder={t`Search by name, phone, email, or district`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<div className="min-w-[170px]">
					<Select
						aria-label={t`Filter customers by district`}
						value={district}
						onValueChange={(value) => value && setDistrict(value)}
						items={{
							all: t`All districts`,
							...Object.fromEntries(districts.map((value) => [value, value])),
						}}
					/>
				</div>
				<div className="min-w-[160px]">
					<Select
						aria-label={t`Filter customers by date`}
						value={period}
						onValueChange={(value) => value && setPeriod(value)}
						items={{ all: t`Any date`, "30": t`Last 30 days`, "90": t`Last 90 days` }}
					/>
				</div>
				<div className="min-w-[170px]">
					<Select
						aria-label={t`Sort customers`}
						value={sort}
						onValueChange={(value) => value && setSort(value)}
						items={{ recent: t`Most recent`, orders: t`Most orders` }}
					/>
				</div>
			</div>
			<div className="overflow-x-auto rounded-lg border border-kumo-line">
				<table className="w-full text-start">
					<thead className="border-b border-kumo-line bg-kumo-tint">
						<tr>
							<th className="p-3 text-start text-sm font-medium">{t`Customer`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Phone`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`District`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Orders`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Last order`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
						</tr>
					</thead>
					<tbody>
						{customers.map((customer) => (
							<CustomerRow
								key={customer.id}
								customer={customer}
								onClick={() => setSelectedCustomer(customer)}
							/>
						))}
					</tbody>
				</table>
			</div>
			{customers.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">{t`No customers match your search.`}</p>
			) : null}
			<Dialog.Root
				open={selectedCustomer !== null}
				onOpenChange={(open) => !open && setSelectedCustomer(null)}
			>
				<Dialog
					className="max-h-[90vh] w-[min(720px,calc(100vw-2rem))] overflow-y-auto p-6"
					size="lg"
				>
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">{t`Customer details`}</Dialog.Title>
						<Dialog.Close
							aria-label={t`Close`}
							render={(props) => (
								<Button {...props} aria-label={t`Close`} variant="ghost" shape="square">
									×
								</Button>
							)}
						/>
					</div>
					{selectedCustomer ? (
						<CustomerDetail
							customer={selectedCustomer}
							currencySymbol={settingsQuery.data?.currencySymbol ?? "S/"}
							onCopy={(value) => {
								void navigator.clipboard?.writeText(value);
								toastManager.add({ title: t`Copied to clipboard`, type: "success" });
							}}
						/>
					) : null}
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
