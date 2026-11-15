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
