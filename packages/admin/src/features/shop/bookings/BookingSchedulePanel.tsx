import { Button, Dialog, Input, Label, LinkButton, Toast } from "@cloudflare/kumo";
import { useLingui } from "@lingui/react/macro";
import { Plus } from "@phosphor-icons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchContentList,
	fetchShopBookingHours,
	updateShopBookingHours,
} from "../../../lib/api/index.js";
import { BOOKING_DAYS, emptyBookingHours, LoadingState, type BookingHourDraft } from "./helpers.js";

export function BookingSchedulePanel() {
	const { t } = useLingui();
	const toastManager = Toast.useToastManager();
	const servicesQuery = useQuery({
		queryKey: ["shop", "booking-services", "es"],
		queryFn: () => fetchContentList("services", { locale: "es", limit: 100 }),
	});
	const services = (servicesQuery.data?.items ?? []).filter((item) => {
		const itemType =
			typeof item.data.item_type === "string" ? item.data.item_type.toLowerCase() : "";
		const registrationMode =
			typeof item.data.registration_mode === "string" ? item.data.registration_mode : "scheduled";
		const requiresBooking = item.data.requires_booking;
		return (
			itemType === "service" &&
			registrationMode !== "open_enrollment" &&
			(requiresBooking === true ||
				requiresBooking === 1 ||
				requiresBooking === "1" ||
				requiresBooking === "true")
		);
	});
	const [serviceId, setServiceId] = React.useState("");
	const [dialogOpen, setDialogOpen] = React.useState(false);
	const [search, setSearch] = React.useState("");
	const [validFrom, setValidFrom] = React.useState("");
	const [validUntil, setValidUntil] = React.useState("");
	const [hours, setHours] = React.useState<BookingHourDraft[]>(emptyBookingHours);
	const [selectedWeekdays, setSelectedWeekdays] = React.useState<number[]>([]);
	const [scheduleError, setScheduleError] = React.useState<string | null>(null);
	const hoursQuery = useQuery({
		queryKey: ["shop", "booking-hours", serviceId],
		queryFn: () => fetchShopBookingHours(serviceId),
		enabled: Boolean(serviceId),
	});
	React.useEffect(() => {
		const next = emptyBookingHours();
		for (const hour of hoursQuery.data ?? []) {
			const row = next[hour.weekday];
			if (row) {
				row.startsAt = hour.startsAt;
				row.endsAt = hour.endsAt;
			}
		}
		setHours(next);
		setSelectedWeekdays(
			(hoursQuery.data ?? [])
				.map((hour) => hour.weekday)
				.filter((weekday, index, weekdays) => weekdays.indexOf(weekday) === index)
				.toSorted((a, b) => a - b),
		);
		const first = hoursQuery.data?.[0];
		setValidFrom(first?.validFrom ?? "");
		setValidUntil(first?.validUntil ?? "");
		setScheduleError(null);
	}, [hoursQuery.data]);
	const saveMutation = useMutation({
		mutationFn: () =>
			updateShopBookingHours(
				serviceId,
				hours.filter(
					(hour) => selectedWeekdays.includes(hour.weekday) && hour.startsAt && hour.endsAt,
				),
				validFrom || null,
				validUntil || null,
			),
		onSuccess: () => {
			setDialogOpen(false);
			toastManager.add({ title: t`Booking schedule saved`, type: "success" });
		},
	});

	if (servicesQuery.isLoading) return <LoadingState label={t`Loading services`} />;
	if (services.length === 0) {
		return (
			<div className="rounded-lg border p-6">
				<p className="text-sm text-kumo-subtle">{t`No bookable services found.`}</p>
				<p className="mt-2 text-sm text-kumo-subtle">
					{t`Create a service to configure its availability and accept bookings.`}
				</p>
				<LinkButton
					href="/_emdash/admin/content/services/new?locale=es&itemType=service"
					className="mt-4"
					icon={<Plus />}
				>
					{t`Add service`}
				</LinkButton>
			</div>
		);
	}
	const normalizedSearch = search.trim().toLowerCase();
	const visibleServices = services.filter((service) => {
		const name =
			typeof service.data.name === "string" ? service.data.name : (service.slug ?? service.id);
		return !normalizedSearch || name.toLowerCase().includes(normalizedSearch);
	});
	const openSchedule = (id: string) => {
		setServiceId(id);
		setDialogOpen(true);
	};
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end gap-3">
				<div className="min-w-[240px] flex-1">
					<Input
						label={t`Search services`}
						placeholder={t`Search by service name`}
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</div>
			</div>
			<div className="overflow-x-auto rounded-lg border border-kumo-line">
				<table className="w-full text-start">
					<thead className="border-b border-kumo-line bg-kumo-tint">
						<tr>
							<th className="p-3 text-start text-sm font-medium">{t`Service`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Type`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Duration`}</th>
							<th className="p-3 text-start text-sm font-medium">{t`Capacity`}</th>
							<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
						</tr>
					</thead>
					<tbody>
						{visibleServices.map((service) => {
							const name =
								typeof service.data.name === "string"
									? service.data.name
									: (service.slug ?? service.id);
							return (
								<tr
									key={service.id}
									className="border-b border-kumo-line last:border-0 hover:bg-kumo-tint"
								>
									<td className="p-3 font-medium">{name}</td>
									<td className="p-3">
										{service.data.service_mode === "online" ? t`Online` : t`In person`}
									</td>
									<td className="p-3">
										{typeof service.data.duration_minutes === "number"
											? `${service.data.duration_minutes} min`
											: t`Not set`}
									</td>
									<td className="p-3">
										{typeof service.data.service_capacity === "number"
											? service.data.service_capacity
											: 1}
									</td>
									<td className="p-3 text-end">
										<Button
											size="sm"
											variant="outline"
											onClick={() => openSchedule(service.id)}
										>{t`Schedule`}</Button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			{visibleServices.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">{t`No services match your search.`}</p>
			) : null}
			<Dialog.Root open={dialogOpen} onOpenChange={setDialogOpen}>
				<Dialog
					className="max-h-[90vh] w-[min(720px,calc(100vw-2rem))] overflow-y-auto p-6"
					size="lg"
				>
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">{t`Schedule service availability`}</Dialog.Title>
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
						className="space-y-5"
						onSubmit={(event) => {
							event.preventDefault();
							const incomplete = hours.some(
								(hour) =>
									selectedWeekdays.includes(hour.weekday) && (!hour.startsAt || !hour.endsAt),
							);
							if (selectedWeekdays.length === 0) {
								setScheduleError(t`Select at least one available day.`);
								return;
							}
							if (incomplete) {
								setScheduleError(t`Add a start and end time for each selected day.`);
								return;
							}
							setScheduleError(null);
							saveMutation.mutate();
						}}
					>
						<div className="grid gap-4 sm:grid-cols-2">
							<Input
								label={t`Start date`}
								type="date"
								value={validFrom}
								onChange={(event) => setValidFrom(event.target.value)}
								required
							/>
							<Input
								label={t`End date`}
								type="date"
								value={validUntil}
								onChange={(event) => setValidUntil(event.target.value)}
								required
							/>
						</div>
						<p className="text-sm text-kumo-subtle">{t`Choose the date range in which this weekly schedule can be booked. Days outside the selected range or selected weekdays are unavailable.`}</p>
						<div>
							<Label>{t`Available days`}</Label>
							<p className="mt-1 text-sm text-kumo-subtle">{t`Select only the days when this service is available. Saturday and Sunday can be left unselected.`}</p>
							<div className="mt-3 flex flex-wrap gap-2">
								{BOOKING_DAYS.map((day, weekday) => {
									const selected = selectedWeekdays.includes(weekday);
									return (
										<Button
											key={weekday}
											type="button"
											size="sm"
											variant={selected ? "primary" : "outline"}
											aria-pressed={selected}
											onClick={() =>
												setSelectedWeekdays((current) =>
													selected
														? current.filter((value) => value !== weekday)
														: [...current, weekday].toSorted((a, b) => a - b),
												)
											}
										>
											{t(day)}
										</Button>
									);
								})}
							</div>
						</div>
						<div className="space-y-3">
							{hours
								.filter((hour) => selectedWeekdays.includes(hour.weekday))
								.map((hour) => (
									<div
										key={hour.weekday}
										className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_1fr]"
									>
										<Label>{t(BOOKING_DAYS[hour.weekday]!)}</Label>
										<Input
											label={t`Starts at`}
											type="time"
											value={hour.startsAt}
											onChange={(event) =>
												setHours((current) =>
													current.map((item) =>
														item.weekday === hour.weekday
															? { ...item, startsAt: event.target.value }
															: item,
													),
												)
											}
										/>
										<Input
											label={t`Ends at`}
											type="time"
											value={hour.endsAt}
											onChange={(event) =>
												setHours((current) =>
													current.map((item) =>
														item.weekday === hour.weekday
															? { ...item, endsAt: event.target.value }
															: item,
													),
												)
											}
										/>
									</div>
								))}
						</div>
						{scheduleError ? <p className="text-sm text-kumo-danger">{scheduleError}</p> : null}
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								onClick={() => setDialogOpen(false)}
							>{t`Cancel`}</Button>
							<Button type="submit" disabled={saveMutation.isPending}>
								{saveMutation.isPending ? t`Saving…` : t`Save schedule`}
							</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
