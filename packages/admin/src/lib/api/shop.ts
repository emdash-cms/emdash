import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface ShopSettings {
	id: string;
	storeName: string;
	currency: string;
	currencySymbol: string;
	whatsappNumber: string | null;
	whatsappMessage: string | null;
	paymentMethods: string[];
	deliveryInstructions: string | null;
	businessHours: string | null;
	preparationTime: string | null;
	minimumSubtotal: number;
	freeDeliveryMinSubtotal: number | null;
	whatsappTemplates: Record<string, string>;
	bookingEnabled: boolean;
	paymentGatewayEnabled: boolean;
	paymentGatewayProvider: string | null;
	paymentGatewayEnvironment: "sandbox" | "production";
	paymentGatewayPublicKey: string | null;
	paymentGatewaySecretKeyConfigured: boolean;
	paymentGatewayWebhookSecretConfigured: boolean;
	paymentGatewayReturnUrl: string | null;
	paymentGatewayWebhookUrl: string | null;
}

export interface ShopSettingsUpdateInput extends Partial<Omit<ShopSettings, "id">> {
	paymentGatewaySecretKey?: string | null;
	paymentGatewayWebhookSecret?: string | null;
}

export interface ShopDeliveryZone {
	id: string;
	name: string;
	districts: string[];
	deliveryCost: number;
	estimatedTime: string | null;
	active: boolean;
}

export interface ShopBookingHour {
	id: string;
	serviceId: string;
	weekday: number;
	startsAt: string;
	endsAt: string;
	validFrom: string | null;
	validUntil: string | null;
	active: boolean;
}

export interface ShopReservationSummary {
	id: string;
	serviceId: string;
	orderId: string | null;
	orderItemId: string | null;
	startsAt: string;
	endsAt: string;
	status: string;
	expiresAt: string | null;
	customerName: string | null;
	serviceName: string | null;
	createdAt: string | null;
}

export interface ShopEnrollmentSummary {
	id: string;
	serviceId: string;
	orderId: string | null;
	orderItemId: string | null;
	customerId: string | null;
	quantity: number;
	startsAt: string | null;
	endsAt: string | null;
	status: string;
	customerName: string | null;
	serviceName: string | null;
	capacity: number | null;
	enrolled: number;
	createdAt: string | null;
}

export interface ShopCoupon {
	id: string;
	code: string;
	discountType: "percentage" | "fixed";
	discountValue: number;
	minimumSubtotal: number;
	startsAt: string | null;
	expiresAt: string | null;
	usageLimit: number | null;
	usageCount: number;
	active: boolean;
	createdAt: string | null;
	updatedAt: string | null;
}

export interface ShopOrderSummary {
	id: string;
	orderNumber: string;
	status: string;
	paymentStatus: string;
	deliveryStatus: string;
	currency: string;
	currencySymbol: string;
	subtotal: number;
	discount: number;
	deliveryCost: number;
	total: number;
	whatsappUrl: string | null;
	couponCode?: string | null;
	couponDiscount?: number;
}

export interface ShopOrderDetail extends ShopOrderSummary {
	items: Array<{
		id: string;
		productId: string;
		variantId: string | null;
		productName: string;
		variantName: string | null;
		unitPrice: number;
		quantity: number;
		discount: number;
		subtotal: number;
	}>;
	customer: Record<string, unknown>;
	delivery: Record<string, unknown>;
	notes: string | null;
}

export interface ShopCustomerSummary {
	id: string;
	name: string;
	phone: string;
	email: string | null;
	address: string | null;
	district: string | null;
	reference: string | null;
	notes: string | null;
	createdAt: string | null;
	updatedAt: string | null;
	orderCount: number;
	totalSpent: number;
	lastOrderNumber: string | null;
	lastOrderStatus: string | null;
	lastOrderCreatedAt: string | null;
	orders: Array<{ orderNumber: string; status: string; total: number; createdAt: string | null }>;
}

async function get<T>(path: string): Promise<T> {
	return parseApiResponse<T>(await apiFetch(`${API_BASE}${path}`));
}

async function mutate<T>(path: string, method: string, body: unknown): Promise<T> {
	return parseApiResponse<T>(
		await apiFetch(`${API_BASE}${path}`, {
			method,
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

export function fetchShopSettings(): Promise<ShopSettings> {
	return get("/admin/shop/settings");
}

export function updateShopSettings(input: ShopSettingsUpdateInput): Promise<ShopSettings> {
	return mutate("/admin/shop/settings", "PUT", input);
}

export function fetchShopBookingHours(serviceId: string): Promise<ShopBookingHour[]> {
	return get(`/admin/shop/booking-hours?serviceId=${encodeURIComponent(serviceId)}`);
}

export function updateShopBookingHours(
	serviceId: string,
	hours: Array<{ weekday: number; startsAt: string; endsAt: string }>,
	validFrom?: string | null,
	validUntil?: string | null,
): Promise<ShopBookingHour[]> {
	return mutate("/admin/shop/booking-hours", "PUT", { serviceId, hours, validFrom, validUntil });
}

export function fetchShopReservations(status = "all"): Promise<ShopReservationSummary[]> {
	return get(`/admin/shop/reservations?status=${encodeURIComponent(status)}`);
}

export function updateShopReservation(id: string, status: string): Promise<ShopReservationSummary> {
	return mutate(`/admin/shop/reservations/${encodeURIComponent(id)}`, "PATCH", { status });
}

export function fetchShopEnrollments(status = "all"): Promise<ShopEnrollmentSummary[]> {
	return get(`/admin/shop/enrollments?status=${encodeURIComponent(status)}`);
}

export function updateShopEnrollment(
	id: string,
	input: { status: string; startsAt?: string; endsAt?: string },
): Promise<ShopEnrollmentSummary> {
	return mutate(`/admin/shop/enrollments/${encodeURIComponent(id)}`, "PATCH", input);
}

export function fetchShopDeliveryZones(): Promise<ShopDeliveryZone[]> {
	return get("/admin/shop/delivery-zones");
}

export function createShopDeliveryZone(input: {
	name: string;
	districts: string[];
	deliveryCost: number;
	estimatedTime?: string | null;
	active?: boolean;
}): Promise<ShopDeliveryZone> {
	return mutate("/admin/shop/delivery-zones", "POST", input);
}

export function updateShopDeliveryZone(
	id: string,
	input: Partial<Parameters<typeof createShopDeliveryZone>[0]>,
): Promise<ShopDeliveryZone> {
	return mutate(`/admin/shop/delivery-zones/${encodeURIComponent(id)}`, "PATCH", input);
}

export function deleteShopDeliveryZone(id: string): Promise<null> {
	return mutate(`/admin/shop/delivery-zones/${encodeURIComponent(id)}`, "DELETE", undefined);
}

export function fetchShopCoupons(): Promise<ShopCoupon[]> {
	return get("/admin/shop/coupons");
}

export function createShopCoupon(input: {
	code: string;
	discountType: "percentage" | "fixed";
	discountValue: number;
	minimumSubtotal?: number;
	startsAt?: string | null;
	expiresAt?: string | null;
	usageLimit?: number | null;
	active?: boolean;
}): Promise<ShopCoupon> {
	return mutate("/admin/shop/coupons", "POST", input);
}

export function updateShopCoupon(
	id: string,
	input: Partial<Parameters<typeof createShopCoupon>[0]>,
): Promise<ShopCoupon> {
	return mutate(`/admin/shop/coupons/${encodeURIComponent(id)}`, "PATCH", input);
}

export function deleteShopCoupon(id: string): Promise<null> {
	return mutate(`/admin/shop/coupons/${encodeURIComponent(id)}`, "DELETE", undefined);
}

export function fetchShopOrders(): Promise<ShopOrderSummary[]> {
	return get("/admin/shop/orders");
}

export function fetchShopCustomers(): Promise<ShopCustomerSummary[]> {
	return get("/admin/shop/customers");
}

export function fetchShopOrder(id: string): Promise<ShopOrderDetail> {
	return get(`/admin/shop/orders/${encodeURIComponent(id)}`);
}

export function fetchShopOrderWhatsAppUrl(id: string, template: string): Promise<string> {
	return get<string>(
		`/admin/shop/orders/${encodeURIComponent(id)}/whatsapp?template=${encodeURIComponent(template)}`,
	);
}

export function confirmShopPayment(
	id: string,
	input: { reference?: string; notes?: string } = {},
): Promise<null> {
	return mutate(`/admin/shop/orders/${encodeURIComponent(id)}/payment`, "POST", input);
}

export function updateShopDelivery(
	id: string,
	input: {
		status: string;
		courierName?: string;
		trackingCode?: string | null;
		trackingUrl?: string | null;
		cancellationReason?: string | null;
	},
): Promise<null> {
	return mutate(`/admin/shop/orders/${encodeURIComponent(id)}/delivery`, "PATCH", input);
}
