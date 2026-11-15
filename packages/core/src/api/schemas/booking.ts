import { z } from "zod";

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must use YYYY-MM-DD");
const isoDateTime = z.string().datetime({ offset: true });

export const shopBookingAvailabilityQuery = z.object({
	date: dateOnly,
	locale: z.string().min(2).max(20).default("es"),
});

export const shopBookingHoldBody = z.object({
	serviceId: z.string().min(1),
	startsAt: isoDateTime,
	endsAt: isoDateTime,
	locale: z.string().min(2).max(20).default("es"),
});

const bookingHour = z.object({
	weekday: z.number().int().min(0).max(6),
	startsAt: z.string().regex(/^\d{2}:\d{2}$/),
	endsAt: z.string().regex(/^\d{2}:\d{2}$/),
});

export const shopBookingHoursUpdateBody = z.object({
	serviceId: z.string().min(1),
	hours: z.array(bookingHour).max(100),
	validFrom: dateOnly.nullable().optional(),
	validUntil: dateOnly.nullable().optional(),
});

export const shopReservationUpdateBody = z.object({
	status: z.enum([
		"held",
		"pending_payment",
		"confirmed",
		"cancelled",
		"expired",
		"completed",
		"no_show",
	]),
	startsAt: isoDateTime.optional(),
	endsAt: isoDateTime.optional(),
});

export const shopEnrollmentUpdateBody = z.object({
	status: z.enum(["pending_schedule", "scheduled", "cancelled"]),
	startsAt: isoDateTime.optional(),
	endsAt: isoDateTime.optional(),
});

export const shopBookingBlockCreateBody = z.object({
	serviceId: z.string().min(1).nullable().optional(),
	startsAt: isoDateTime,
	endsAt: isoDateTime,
	reason: z.string().max(500).nullable().optional(),
});
