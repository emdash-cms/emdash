import { Badge, Button, Dialog, Input, Label, Select } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import {
	fetchShopEnrollments,
	type ShopEnrollmentSummary,
	updateShopEnrollment,
} from "../../../lib/api/index.js";
import { LoadingState } from "./helpers.js";

export function OpenEnrollmentsPanel() {
	const { t } = useLingui();
	const queryClient = useQueryClient();
	const [status, setStatus] = React.useState("all");
	const enrollmentsQuery = useQuery({
		queryKey: ["shop", "enrollments", status],
		queryFn: () => fetchShopEnrollments(status),
	});
	const [selectedEnrollment, setSelectedEnrollment] = React.useState<ShopEnrollmentSummary | null>(
		null,
	);
	const [startsAt, setStartsAt] = React.useState("");
	const [endsAt, setEndsAt] = React.useState("");
	const updateMutation = useMutation({
		mutationFn: ({
			id,
			nextStatus,
			nextStartsAt,
			nextEndsAt,
		}: {
			id: string;
			nextStatus: string;
			nextStartsAt?: string;
			nextEndsAt?: string;
		}) =>
			updateShopEnrollment(id, { status: nextStatus, startsAt: nextStartsAt, endsAt: nextEndsAt }),
		onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["shop", "enrollments"] }),
	});
	const enrollments = enrollmentsQuery.data ?? [];
	const closeScheduleDialog = () => {
		setSelectedEnrollment(null);
		setStartsAt("");
		setEndsAt("");
	};
	const statusLabel = (value: string) => {
		const labels: Record<string, MessageDescriptor> = {
			pending_schedule: msg`Pending schedule`,
			scheduled: msg`Scheduled`,
			cancelled: msg`Cancelled`,
		};
		return labels[value] ? t(labels[value]) : value;
	};
	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-end justify-between gap-3">
				<div>
					<h2 className="text-xl font-semibold">{t`Open enrollments`}</h2>
					<p className="mt-1 text-sm text-kumo-subtle">
						{t`Review people registered for services without a fixed date.`}
					</p>
				</div>
				<Select
					aria-label={t`Filter enrollments by status`}
					value={status}
					onValueChange={(value) => value && setStatus(value)}
					items={{
						all: t`All statuses`,
						pending_schedule: t`Pending schedule`,
						scheduled: t`Scheduled`,
						cancelled: t`Cancelled`,
					}}
				/>
			</div>
			{enrollmentsQuery.isLoading ? <LoadingState label={t`Loading enrollments`} /> : null}
			{!enrollmentsQuery.isLoading && enrollments.length === 0 ? (
				<p className="rounded-lg border p-6 text-sm text-kumo-subtle">
					{t`No open enrollments found.`}
				</p>
			) : null}
			{enrollments.length > 0 ? (
				<div className="overflow-x-auto rounded-lg border border-kumo-line">
					<table className="w-full text-start">
						<thead className="border-b border-kumo-line bg-kumo-tint">
							<tr>
								<th className="p-3 text-start text-sm font-medium">{t`Service`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Customer`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`People`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Capacity`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Status`}</th>
								<th className="p-3 text-start text-sm font-medium">{t`Registered`}</th>
								<th className="p-3 text-end text-sm font-medium">{t`Actions`}</th>
							</tr>
						</thead>
						<tbody>
							{enrollments.map((enrollment: ShopEnrollmentSummary) => (
								<tr key={enrollment.id} className="border-b border-kumo-line last:border-0">
									<td className="p-3 font-medium">
										{enrollment.serviceName ?? enrollment.serviceId}
									</td>
									<td className="p-3">{enrollment.customerName ?? t`Customer`}</td>
									<td className="p-3">{enrollment.quantity}</td>
									<td className="p-3">
										{enrollment.capacity === null
											? "—"
											: `${enrollment.enrolled} / ${enrollment.capacity}`}
									</td>
									<td className="p-3">
										<Badge>{statusLabel(enrollment.status)}</Badge>
									</td>
									<td className="p-3 text-sm">
										{enrollment.createdAt
											? new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
													new Date(enrollment.createdAt),
												)
											: "—"}
									</td>
									<td className="p-3 text-end">
										<div className="flex flex-wrap justify-end gap-2">
											{enrollment.status === "pending_schedule" ? (
												<Button
													type="button"
													size="sm"
													variant="outline"
													onClick={() => {
														setSelectedEnrollment(enrollment);
														setStartsAt("");
														setEndsAt("");
													}}
												>
													{t`Schedule`}
												</Button>
											) : null}
											{enrollment.status !== "cancelled" ? (
												<Button
													type="button"
													size="sm"
													variant="outline"
													disabled={updateMutation.isPending}
													onClick={() =>
														updateMutation.mutate({ id: enrollment.id, nextStatus: "cancelled" })
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
				open={selectedEnrollment !== null}
				onOpenChange={(open) => !open && closeScheduleDialog()}
			>
				<Dialog className="w-[min(560px,calc(100vw-2rem))] p-6">
					<div className="mb-4 flex items-center justify-between gap-4">
						<Dialog.Title className="text-lg font-semibold">{t`Schedule`}</Dialog.Title>
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
							if (!selectedEnrollment || !startsAt || !endsAt) return;
							updateMutation.mutate({
								id: selectedEnrollment.id,
								nextStatus: "scheduled",
								nextStartsAt: new Date(startsAt).toISOString(),
								nextEndsAt: new Date(endsAt).toISOString(),
							});
							closeScheduleDialog();
						}}
					>
						<div>
							<Label>{t`Start date`}</Label>
							<Input
								type="datetime-local"
								value={startsAt}
								onChange={(event) => setStartsAt(event.target.value)}
								required
							/>
						</div>
						<div>
							<Label>{t`End date`}</Label>
							<Input
								type="datetime-local"
								value={endsAt}
								onChange={(event) => setEndsAt(event.target.value)}
								required
							/>
						</div>
						<div className="flex justify-end gap-2">
							<Button
								type="button"
								variant="ghost"
								onClick={closeScheduleDialog}
							>{t`Cancel`}</Button>
							<Button type="submit" disabled={updateMutation.isPending}>{t`Save schedule`}</Button>
						</div>
					</form>
				</Dialog>
			</Dialog.Root>
		</div>
	);
}
