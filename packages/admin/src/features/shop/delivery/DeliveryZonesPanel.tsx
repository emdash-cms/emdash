import { Button, Dialog, Input, Loader, Switch, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	createShopDeliveryZone,
	deleteShopDeliveryZone,
	fetchShopDeliveryZones,
	fetchShopSettings,
	updateShopDeliveryZone,
} from "../../../lib/api/index.js";
import type { ShopDeliveryZone } from "../../../lib/api/index.js";
import { DeliveryZoneRow } from "./DeliveryZoneRow.js";

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

export function DeliveryZonesPanel() {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const queryClient = useQueryClient();
	const zonesQuery = useQuery({
		queryKey: ["shop", "delivery-zones"],
		queryFn: fetchShopDeliveryZones,
	});
	const settingsQuery = useQuery({ queryKey: ["shop", "settings"], queryFn: fetchShopSettings });
	const [name, setName] = React.useState("");
	const [districts, setDistricts] = React.useState("");
	const [cost, setCost] = React.useState("0");
	const [estimatedTime, setEstimatedTime] = React.useState("");
	const [editingZone, setEditingZone] = React.useState<ShopDeliveryZone | null>(null);
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const [editForm, setEditForm] = React.useState({
		name: "",
		districts: "",
		deliveryCost: "0",
		estimatedTime: "",
		active: true,
	});

	const createMutation = useMutation({
		mutationFn: () =>
			createShopDeliveryZone({
				name,
				districts: districts
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean),
				deliveryCost: Number(cost),
				estimatedTime: estimatedTime || null,
			}),
		onSuccess: () => {
			setName("");
			setDistricts("");
			setCost("0");
			setEstimatedTime("");
			setDialogOpen(false);
			void queryClient.invalidateQueries({ queryKey: ["shop", "delivery-zones"] });
			toastManager.add({ title: t`Delivery zone created`, type: "success" });
		},
	});
	const updateMutation = useMutation({
		mutationFn: () =>
			updateShopDeliveryZone(editingZone?.id ?? "", {
				name: editForm.name,
				districts: editForm.districts
					.split(",")
					.map((item) => item.trim())
					.filter(Boolean),
				deliveryCost: Number(editForm.deliveryCost),
				estimatedTime: editForm.estimatedTime || null,
				active: editForm.active,
			}),
		onSuccess: () => {
			setEditingZone(null);
			setDialogOpen(false);
			void queryClient.invalidateQueries({ queryKey: ["shop", "delivery-zones"] });
			toastManager.add({ title: t`Delivery zone updated`, type: "success" });
		},
	});
	const deleteMutation = useMutation({
		mutationFn: deleteShopDeliveryZone,
		onSuccess: () => {
			void queryClient.invalidateQueries({ queryKey: ["shop", "delivery-zones"] });
			toastManager.add({ title: t`Delivery zone deleted`, type: "success" });
		},
	});

	if (zonesQuery.isLoading || settingsQuery.isLoading) {
		return <LoadingState label={t`Loading delivery zones`} />;
	}
	if (zonesQuery.isError || settingsQuery.isError) {
		return <ErrorState label={t`Could not load delivery zones. Please try again.`} />;
	}
	const normalizedSearch = search.trim().toLowerCase();
	const zones = (zonesQuery.data ?? []).filter(
		(zone) =>
			!normalizedSearch ||
			[zone.name, ...zone.districts].some((value) =>
				value.toLowerCase().includes(normalizedSearch),
			),
	);
	const openCreate = () => {
		setEditingZone(null);
		setName("");
		setDistricts("");
		setCost("0");
		setEstimatedTime("");
		setDialogOpen(true);
	};
	const openEdit = (zone: ShopDeliveryZone) => {
		setEditingZone(zone);
		setEditForm({
			name: zone.name,
			districts: zone.districts.join(", "),
			deliveryCost: String(zone.deliveryCost),
			estimatedTime: zone.estimatedTime ?? "",
			active: zone.active,
		});
		setDialogOpen(true);
	};

	return (
		<div className="space-y-6">
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-[240px] flex-1">
					<Input
						label={t`Search delivery zones`}
						placeholder={t`Search by zone or district`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
				<Button icon={Plus} onClick={openCreate}>
					{t`New delivery zone`}
				</Button>
			</div>
			<div className="overflow-x-auto rounded-lg border border-kumo-line">
				<table className="w-full text-start">
					<thead className="border-b border-kumo-line bg-kumo-tint">
						<tr>
							<th className="p-3 text-start text-sm font-medium">{t`Zone`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Districts`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Cost`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Estimated time`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Status`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
						</tr>
					</thead>
					<tbody>
						{zones.map((zone) => (
							<DeliveryZoneRow
								key={zone.id}
								zone={zone}
								currencySymbol={settingsQuery.data?.currencySymbol ?? "S/"}
								onDelete={() => deleteMutation.mutate(zone.id)}
								onEdit={() => openEdit(zone)}
							/>
						))}
					</tbody>
				</table>
			</div>
			{zones.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">
					{t`No delivery zones match your search.`}
				</p>
			) : null}
			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog
					className="max-h-[90vh] w-[min(600px,calc(100vw-2rem))] overflow-y-auto p-6"
					size="lg"
				>
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">
							{editingZone ? t`Edit delivery zone` : t`New delivery zone`}
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
							if (editingZone) updateMutation.mutate();
							else createMutation.mutate();
						}}
					>
						<Input
							label={t`Zone name`}
							value={editingZone ? editForm.name : name}
							onChange={(event) =>
								editingZone
									? setEditForm({ ...editForm, name: event.target.value })
									: setName(event.target.value)
							}
							required
						/>
						<Input
							label={t`Districts`}
							value={editingZone ? editForm.districts : districts}
							onChange={(event) =>
								editingZone
									? setEditForm({ ...editForm, districts: event.target.value })
									: setDistricts(event.target.value)
							}
							placeholder={t`District 1, District 2`}
							required
						/>
						<Input
							label={t`Delivery cost`}
							type="number"
							min="0"
							step="0.01"
							value={editingZone ? editForm.deliveryCost : cost}
							onChange={(event) =>
								editingZone
									? setEditForm({ ...editForm, deliveryCost: event.target.value })
									: setCost(event.target.value)
							}
							required
						/>
						<Input
							label={t`Estimated time`}
							value={editingZone ? editForm.estimatedTime : estimatedTime}
							onChange={(event) =>
								editingZone
									? setEditForm({ ...editForm, estimatedTime: event.target.value })
									: setEstimatedTime(event.target.value)
							}
							placeholder={t`Example: 30–60 minutes`}
						/>
						{editingZone ? (
							<Switch
								label={t`Active`}
								checked={editForm.active}
								onCheckedChange={(checked) =>
									setEditForm({ ...editForm, active: Boolean(checked) })
								}
							/>
						) : null}
						<div className="flex justify-end gap-2">
							<Button type="button" variant="ghost" onClick={() => setDialogOpen(false)}>
								{t`Cancel`}
							</Button>
							<Button type="submit" disabled={createMutation.isPending || updateMutation.isPending}>
								{createMutation.isPending || updateMutation.isPending ? t`Saving...` : t`Save zone`}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
