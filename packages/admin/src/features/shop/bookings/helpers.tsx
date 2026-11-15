import { Loader } from "@cloudflare/kumo";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

export function formatStatus(status: string, t: (descriptor: MessageDescriptor) => string): string {
	const labels: Record<string, MessageDescriptor> = {
		new: msg`New`,
		confirmed: msg`Confirmed`,
		preparing: msg`Preparing`,
		ready: msg`Ready for delivery`,
		in_transit: msg`In transit`,
		delivered: msg`Delivered`,
		cancelled: msg`Cancelled`,
		not_delivered: msg`Not delivered`,
		rescheduled: msg`Rescheduled`,
		pending: msg`Pending`,
	};
	const label = labels[status];
	return label ? t(label) : status;
}

export function money(value: number, symbol: string): string {
	return `${symbol} ${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}`;
}

export const BOOKING_DAYS = [
	msg`Sunday`,
	msg`Monday`,
	msg`Tuesday`,
	msg`Wednesday`,
	msg`Thursday`,
	msg`Friday`,
	msg`Saturday`,
] as const;

export type BookingHourDraft = { weekday: number; startsAt: string; endsAt: string };

export function emptyBookingHours(): BookingHourDraft[] {
	return BOOKING_DAYS.map((_, weekday) => ({ weekday, startsAt: "", endsAt: "" }));
}

export function LoadingState({ label }: { label: string }) {
	return (
		<div className="flex items-center gap-2 text-sm text-kumo-subtle">
			<Loader />
			<span>{label}</span>
		</div>
	);
}
