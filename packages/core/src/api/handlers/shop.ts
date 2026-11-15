import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import { decryptShopSecret, encryptShopSecret } from "../../config/secrets.js";
import { ContentRepository } from "../../database/repositories/content.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database, ShopCouponTable } from "../../database/types.js";
import { invalidateCollectionCache } from "../../object-cache/index.js";
import type { ApiResult } from "../types.js";

const DEFAULT_SETTINGS_ID = "default";
const DEFAULT_CURRENCY = "PEN";
const DEFAULT_CURRENCY_SYMBOL = "S/";
const DEFAULT_PAYMENT_METHODS = ["whatsapp"];
const PRODUCTS_COLLECTION = "products";
const SERVICES_COLLECTION = "services";
type ShopCollection = typeof PRODUCTS_COLLECTION | typeof SERVICES_COLLECTION;

async function shopCartTokenHash(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`shop-cart:${token}`),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeShopCollection(value: string): ShopCollection {
	return value === SERVICES_COLLECTION ? SERVICES_COLLECTION : PRODUCTS_COLLECTION;
}

function currencySymbolForCurrency(currency: string): string {
	return (
		(
			{
				PEN: "S/",
				USD: "$",
				EUR: "€",
				GBP: "£",
				MXN: "$",
				COP: "$",
				CLP: "$",
				ARS: "$",
				BRL: "R$",
			} as Record<string, string>
		)[currency.toUpperCase()] ?? currency
	);
}

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

export interface ShopPublicSettings {
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
}

export interface ShopSettingsUpdateInput extends Partial<Omit<ShopSettings, "id">> {
	paymentGatewaySecretKey?: string | null;
	paymentGatewayWebhookSecret?: string | null;
}

export interface ShopPaymentGatewayCredentials {
	provider: string;
	environment: "sandbox" | "production";
	publicKey: string | null;
	secretKey: string | null;
	webhookSecret: string | null;
	returnUrl: string | null;
	webhookUrl: string | null;
}

export interface ShopDeliveryZone {
	id: string;
	name: string;
	districts: string[];
	deliveryCost: number;
	estimatedTime: string | null;
	active: boolean;
}

export interface ShopOrderInput {
	items: Array<{
		productId: string;
		collection?: ShopCollection;
		variantId?: string;
		quantity: number;
		booking?: { reservationId: string; startsAt: string; endsAt: string };
	}>;
	cartToken?: string;
	customer: {
		firstName: string;
		lastName: string;
		name?: string;
		phone: string;
		email?: string;
		address?: string;
		district?: string;
		reference?: string;
		documentType?: string;
		documentNumber?: string;
		fiscalName?: string;
		fiscalAddress?: string;
	};
	deliveryZoneId?: string;
	deliveryDate?: string;
	deliveryTime?: string;
	recipientName?: string;
	recipientPhone?: string;
	deliveryInstructions?: string;
	paymentMethod: string;
	notes?: string;
	couponCode?: string;
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

type ShopWhatsAppOrder = ShopOrderSummary & {
	items?: Array<{ productName: string; quantity: number; subtotal: number }>;
};

export interface ShopOrderDetail extends ShopOrderSummary {
	items: Array<{
		id: string;
		productId: string;
		collection: ShopCollection;
		variantId: string | null;
		productName: string;
		variantName: string | null;
		unitPrice: number;
		quantity: number;
		discount: number;
		subtotal: number;
		imageUrl?: string | null;
	}>;
	customer: Record<string, unknown>;
	delivery: Record<string, unknown>;
	notes: string | null;
}

function parseJson(value: string | null | undefined): unknown {
	if (!value) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return parsed;
	} catch {
		return null;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getStringField(value: unknown, field: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const fieldValue = value[field];
	return typeof fieldValue === "string" ? fieldValue : undefined;
}

function parseJsonStringArray(value: string | null | undefined, fallback: string[]): string[] {
	const parsed = parseJson(value);
	return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === "string")
		? parsed
		: fallback;
}

async function preserveOrEncryptShopSecret(
	input: string | null | undefined,
	existing: string | null | undefined,
): Promise<string | null> {
	if (input === null) return null;
	if (typeof input === "string" && input.length > 0) return encryptShopSecret(input);
	if (typeof existing === "string" && existing.length > 0) {
		return existing.startsWith("emdash_shop_secret_v1_") ? existing : encryptShopSecret(existing);
	}
	return null;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> {
	const parsed = parseJson(value);
	return isRecord(parsed) ? parsed : {};
}

function parseJsonStringRecord(value: string | null | undefined): Record<string, string> {
	return Object.fromEntries(
		Object.entries(parseJsonRecord(value)).filter(
			(entry): entry is [string, string] => typeof entry[1] === "string",
		),
	);
}

function toSettings(row: {
	id: string;
	store_name: string;
	currency: string;
	currency_symbol: string | null;
	whatsapp_number: string | null;
	whatsapp_message: string | null;
	payment_methods: string;
	delivery_instructions: string | null;
	business_hours: string | null;
	preparation_time: string | null;
	minimum_subtotal: number;
	free_delivery_min_subtotal: number | null;
	whatsapp_templates: string;
	booking_enabled: number;
	payment_gateway_enabled: number;
	payment_gateway_provider: string | null;
	payment_gateway_environment: string;
	payment_gateway_public_key: string | null;
	payment_gateway_secret_key: string | null;
	payment_gateway_webhook_secret: string | null;
	payment_gateway_return_url: string | null;
	payment_gateway_webhook_url: string | null;
}): ShopSettings {
	return {
		id: row.id,
		storeName: row.store_name,
		currency: row.currency,
		currencySymbol: row.currency_symbol || currencySymbolForCurrency(row.currency),
		whatsappNumber: row.whatsapp_number,
		whatsappMessage: row.whatsapp_message,
		paymentMethods: parseJsonStringArray(row.payment_methods, DEFAULT_PAYMENT_METHODS),
		deliveryInstructions: row.delivery_instructions,
		businessHours: row.business_hours,
		preparationTime: row.preparation_time,
		minimumSubtotal: row.minimum_subtotal ?? 0,
		freeDeliveryMinSubtotal: row.free_delivery_min_subtotal,
		whatsappTemplates: parseJsonStringRecord(row.whatsapp_templates),
		bookingEnabled: row.booking_enabled === 1,
		paymentGatewayEnabled: row.payment_gateway_enabled === 1,
		paymentGatewayProvider: row.payment_gateway_provider,
		paymentGatewayEnvironment:
			row.payment_gateway_environment === "production" ? "production" : "sandbox",
		paymentGatewayPublicKey: row.payment_gateway_public_key,
		paymentGatewaySecretKeyConfigured: Boolean(row.payment_gateway_secret_key),
		paymentGatewayWebhookSecretConfigured: Boolean(row.payment_gateway_webhook_secret),
		paymentGatewayReturnUrl: row.payment_gateway_return_url,
		paymentGatewayWebhookUrl: row.payment_gateway_webhook_url,
	};
}

function toDeliveryZone(row: {
	id: string;
	name: string;
	districts: string;
	delivery_cost: number;
	estimated_time: string | null;
	active: number;
}): ShopDeliveryZone {
	return {
		id: row.id,
		name: row.name,
		districts: parseJsonStringArray(row.districts, []),
		deliveryCost: row.delivery_cost,
		estimatedTime: row.estimated_time,
		active: row.active === 1,
	};
}

function productPrice(data: Record<string, unknown>): { price: number; discount: number } | null {
	const regular = typeof data.price === "number" ? data.price : null;
	const promotionalValue = data.promotion_price ?? data.promotionPrice;
	const promotional = typeof promotionalValue === "number" ? promotionalValue : null;
	if (regular === null || regular < 0) return null;
	if (promotional !== null && promotional >= 0 && promotional < regular) {
		return { price: promotional, discount: regular - promotional };
	}
	return { price: regular, discount: 0 };
}

type ShopVariant = {
	id?: string;
	label?: string;
	stock?: number;
	price?: number;
	[key: string]: unknown;
};

function productVariants(data: Record<string, unknown>): ShopVariant[] {
	if (!Array.isArray(data.variants)) return [];
	return data.variants.filter((variant): variant is ShopVariant => isRecord(variant));
}

function isProductAvailable(data: Record<string, unknown>): boolean {
	const availability = data.availability_status ?? data.availability;
	const stock = data.stock;
	return (
		availability !== "sold_out" &&
		availability !== "hidden" &&
		(typeof stock !== "number" ||
			stock > 0 ||
			isBookableService(data) ||
			isOpenEnrollmentService(data))
	);
}

function isOpenEnrollmentService(data: Record<string, unknown>): boolean {
	const itemType = typeof data.item_type === "string" ? data.item_type.toLowerCase() : "";
	return itemType === "service" && data.registration_mode === "open_enrollment";
}

function serviceCapacity(data: Record<string, unknown>): number | null {
	const capacity = data.service_capacity;
	return typeof capacity === "number" && Number.isInteger(capacity) && capacity > 0
		? capacity
		: null;
}

function isBookableService(data: Record<string, unknown>): boolean {
	const itemType = typeof data.item_type === "string" ? data.item_type.toLowerCase() : "";
	const requiresBooking = data.requires_booking;
	return (
		itemType === "service" &&
		(requiresBooking === true ||
			requiresBooking === 1 ||
			requiresBooking === "1" ||
			requiresBooking === "true")
	);
}

function isService(data: Record<string, unknown>): boolean {
	const itemType = typeof data.item_type === "string" ? data.item_type.toLowerCase() : "";
	return itemType === "service";
}

function normalizeCouponCode(code: string): string {
	return code.trim().toUpperCase();
}

type ShopCouponRow = Omit<
	ShopCouponTable,
	"active" | "created_at" | "updated_at" | "usage_count"
> & {
	active: number;
	created_at: string;
	updated_at: string;
	usage_count: number;
};

function toCoupon(row: ShopCouponRow): ShopCoupon {
	return {
		id: row.id,
		code: row.code,
		discountType: row.discount_type === "fixed" ? "fixed" : "percentage",
		discountValue: row.discount_value,
		minimumSubtotal: row.minimum_subtotal,
		startsAt: row.starts_at,
		expiresAt: row.expires_at,
		usageLimit: row.usage_limit,
		usageCount: row.usage_count,
		active: row.active === 1,
		createdAt: row.created_at ?? null,
		updatedAt: row.updated_at ?? null,
	};
}

function couponDiscount(coupon: ShopCoupon, subtotal: number): number {
	const raw =
		coupon.discountType === "percentage"
			? subtotal * (coupon.discountValue / 100)
			: coupon.discountValue;
	return Math.min(subtotal, Math.max(0, Math.round(raw * 100) / 100));
}

function couponIsUsable(coupon: ShopCoupon, subtotal: number, now = new Date()): string | null {
	if (!coupon.active) return "Coupon is inactive";
	if (coupon.startsAt && now < new Date(coupon.startsAt)) return "Coupon is not active yet";
	if (coupon.expiresAt && now > new Date(coupon.expiresAt)) return "Coupon has expired";
	if (coupon.usageLimit !== null && coupon.usageCount >= coupon.usageLimit)
		return "Coupon usage limit reached";
	if (subtotal < coupon.minimumSubtotal) return "Order subtotal does not meet the coupon minimum";
	return null;
}

export async function handleShopCouponList(db: Kysely<Database>): Promise<ApiResult<ShopCoupon[]>> {
	try {
		const rows = await db
			.selectFrom("_emdash_shop_coupons")
			.selectAll()
			.orderBy("created_at", "desc")
			.execute();
		return { success: true, data: rows.map(toCoupon) };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_COUPON_LIST_ERROR", message: "Failed to list coupons" },
		};
	}
}

export async function handleShopCouponValidate(
	db: Kysely<Database>,
	code: string,
	subtotal: number,
): Promise<ApiResult<{ code: string; discount: number; totalAfterDiscount: number }>> {
	try {
		const coupon = await db
			.selectFrom("_emdash_shop_coupons")
			.selectAll()
			.where("code", "=", normalizeCouponCode(code))
			.executeTakeFirst();
		if (!coupon)
			return {
				success: false,
				error: { code: "SHOP_COUPON_INVALID", message: "Coupon is invalid" },
			};
		const parsed = toCoupon(coupon);
		const reason = couponIsUsable(parsed, subtotal);
		if (reason) return { success: false, error: { code: "SHOP_COUPON_INVALID", message: reason } };
		const discount = couponDiscount(parsed, subtotal);
		return {
			success: true,
			data: { code: parsed.code, discount, totalAfterDiscount: subtotal - discount },
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_COUPON_VALIDATE_ERROR", message: "Failed to validate coupon" },
		};
	}
}

export async function handleShopCouponCreate(
	db: Kysely<Database>,
	input: {
		code: string;
		discountType: "percentage" | "fixed";
		discountValue: number;
		minimumSubtotal?: number;
		startsAt?: string | null;
		expiresAt?: string | null;
		usageLimit?: number | null;
		active?: boolean;
	},
): Promise<ApiResult<ShopCoupon>> {
	try {
		const id = ulid();
		await db
			.insertInto("_emdash_shop_coupons")
			.values({
				id,
				code: normalizeCouponCode(input.code),
				discount_type: input.discountType,
				discount_value: input.discountValue,
				minimum_subtotal: input.minimumSubtotal ?? 0,
				starts_at: input.startsAt ?? null,
				expires_at: input.expiresAt ?? null,
				usage_limit: input.usageLimit ?? null,
				active: input.active === false ? 0 : 1,
			})
			.execute();
		const row = await db
			.selectFrom("_emdash_shop_coupons")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return { success: true, data: toCoupon(row) };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_COUPON_CREATE_ERROR", message: "Failed to create coupon" },
		};
	}
}

export async function handleShopCouponUpdate(
	db: Kysely<Database>,
	id: string,
	input: Partial<Parameters<typeof handleShopCouponCreate>[1]>,
): Promise<ApiResult<ShopCoupon>> {
	try {
		const existing = await db
			.selectFrom("_emdash_shop_coupons")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (!existing)
			return { success: false, error: { code: "NOT_FOUND", message: "Coupon not found" } };
		const values = {
			code: input.code === undefined ? existing.code : normalizeCouponCode(input.code),
			discount_type: input.discountType ?? existing.discount_type,
			discount_value: input.discountValue ?? existing.discount_value,
			minimum_subtotal: input.minimumSubtotal ?? existing.minimum_subtotal,
			starts_at: input.startsAt === undefined ? existing.starts_at : input.startsAt,
			expires_at: input.expiresAt === undefined ? existing.expires_at : input.expiresAt,
			usage_limit: input.usageLimit === undefined ? existing.usage_limit : input.usageLimit,
			active: input.active === undefined ? existing.active : input.active ? 1 : 0,
			updated_at: new Date().toISOString(),
		};
		await db.updateTable("_emdash_shop_coupons").set(values).where("id", "=", id).execute();
		return {
			success: true,
			data: toCoupon(
				await db
					.selectFrom("_emdash_shop_coupons")
					.selectAll()
					.where("id", "=", id)
					.executeTakeFirstOrThrow(),
			),
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_COUPON_UPDATE_ERROR", message: "Failed to update coupon" },
		};
	}
}

export async function handleShopCouponDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<null>> {
	try {
		const result = await db.deleteFrom("_emdash_shop_coupons").where("id", "=", id).execute();
		return Number(result[0]?.numDeletedRows ?? 0)
			? { success: true, data: null }
			: { success: false, error: { code: "NOT_FOUND", message: "Coupon not found" } };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_COUPON_DELETE_ERROR", message: "Failed to delete coupon" },
		};
	}
}

class ShopStockError extends Error {}
class ShopCouponError extends Error {}
class ShopCapacityError extends Error {}

function makeOrderNumber(): string {
	return `#${Date.now().toString(36).toUpperCase()}-${ulid().slice(-4)}`;
}

function makeWhatsAppUrl(
	phone: string | null,
	order: ShopWhatsAppOrder,
	settings: ShopSettings,
	customer?: Record<string, unknown>,
	delivery?: Record<string, unknown>,
	templateKey?: string,
): string | null {
	if (!phone) return null;
	const cleanPhone = phone.replace(/\D/g, "");
	if (!cleanPhone) return null;
	const itemLines =
		order.items?.map(
			(item) =>
				`- ${item.productName} x${item.quantity}: ${settings.currencySymbol} ${item.subtotal.toFixed(2)}`,
		) ?? [];
	const message = [
		(templateKey ? settings.whatsappTemplates[templateKey] : null) ||
			settings.whatsappMessage ||
			settings.whatsappTemplates.orderReceived ||
			"Hola, quiero coordinar el pago de mi pedido.",
		settings.storeName ? `Tienda: ${settings.storeName}` : null,
		`Pedido: ${order.orderNumber}`,
		typeof customer?.name === "string" ? `Cliente: ${customer.name}` : null,
		typeof delivery?.address === "string"
			? `Delivery: ${delivery.address}${typeof delivery.district === "string" ? `, ${delivery.district}` : ""}`
			: null,
		...itemLines,
		order.couponCode
			? `Cupón: ${order.couponCode} (-${settings.currencySymbol} ${(order.couponDiscount ?? 0).toFixed(2)})`
			: null,
		`Total: ${settings.currencySymbol} ${order.total.toFixed(2)}`,
	]
		.filter((line): line is string => line !== null)
		.join("\n");
	return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
}

export async function handleShopSettingsGet(
	db: Kysely<Database>,
): Promise<ApiResult<ShopSettings>> {
	try {
		const row = await db
			.selectFrom("_emdash_shop_settings")
			.selectAll()
			.where("id", "=", DEFAULT_SETTINGS_ID)
			.executeTakeFirst();
		if (row) return { success: true, data: toSettings(row) };
		return {
			success: true,
			data: {
				id: DEFAULT_SETTINGS_ID,
				storeName: "",
				currency: DEFAULT_CURRENCY,
				currencySymbol: DEFAULT_CURRENCY_SYMBOL,
				whatsappNumber: null,
				whatsappMessage: null,
				paymentMethods: DEFAULT_PAYMENT_METHODS,
				deliveryInstructions: null,
				businessHours: null,
				preparationTime: null,
				minimumSubtotal: 0,
				freeDeliveryMinSubtotal: null,
				whatsappTemplates: {},
				bookingEnabled: false,
				paymentGatewayEnabled: false,
				paymentGatewayProvider: null,
				paymentGatewayEnvironment: "sandbox",
				paymentGatewayPublicKey: null,
				paymentGatewaySecretKeyConfigured: false,
				paymentGatewayWebhookSecretConfigured: false,
				paymentGatewayReturnUrl: null,
				paymentGatewayWebhookUrl: null,
			},
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_SETTINGS_READ_ERROR", message: "Failed to get shop settings" },
		};
	}
}

export async function handleShopPublicSettingsGet(
	db: Kysely<Database>,
): Promise<ApiResult<ShopPublicSettings>> {
	const result = await handleShopSettingsGet(db);
	if (!result.success) return result;
	const {
		id,
		storeName,
		currency,
		currencySymbol,
		whatsappNumber,
		whatsappMessage,
		paymentMethods,
		deliveryInstructions,
		businessHours,
		preparationTime,
		minimumSubtotal,
		freeDeliveryMinSubtotal,
		whatsappTemplates,
		bookingEnabled,
	} = result.data;
	return {
		success: true,
		data: {
			id,
			storeName,
			currency,
			currencySymbol,
			whatsappNumber,
			whatsappMessage,
			paymentMethods,
			deliveryInstructions,
			businessHours,
			preparationTime,
			minimumSubtotal,
			freeDeliveryMinSubtotal,
			whatsappTemplates,
			bookingEnabled,
		},
	};
}

export async function handleShopSettingsUpdate(
	db: Kysely<Database>,
	input: ShopSettingsUpdateInput,
): Promise<ApiResult<ShopSettings>> {
	try {
		const existing = await db
			.selectFrom("_emdash_shop_settings")
			.selectAll()
			.where("id", "=", DEFAULT_SETTINGS_ID)
			.executeTakeFirst();
		const [paymentGatewaySecretKey, paymentGatewayWebhookSecret] = await Promise.all([
			preserveOrEncryptShopSecret(
				input.paymentGatewaySecretKey,
				existing?.payment_gateway_secret_key,
			),
			preserveOrEncryptShopSecret(
				input.paymentGatewayWebhookSecret,
				existing?.payment_gateway_webhook_secret,
			),
		]);
		const values = {
			store_name: input.storeName ?? existing?.store_name ?? "",
			currency: input.currency ?? existing?.currency ?? DEFAULT_CURRENCY,
			currency_symbol:
				input.currencySymbol ??
				existing?.currency_symbol ??
				currencySymbolForCurrency(input.currency ?? existing?.currency ?? DEFAULT_CURRENCY),
			whatsapp_number: input.whatsappNumber ?? existing?.whatsapp_number ?? null,
			whatsapp_message: input.whatsappMessage ?? existing?.whatsapp_message ?? null,
			payment_methods: JSON.stringify(
				input.paymentMethods ??
					parseJsonStringArray(existing?.payment_methods, DEFAULT_PAYMENT_METHODS),
			),
			delivery_instructions: input.deliveryInstructions ?? existing?.delivery_instructions ?? null,
			business_hours: input.businessHours ?? existing?.business_hours ?? null,
			preparation_time: input.preparationTime ?? existing?.preparation_time ?? null,
			minimum_subtotal: input.minimumSubtotal ?? existing?.minimum_subtotal ?? 0,
			free_delivery_min_subtotal:
				input.freeDeliveryMinSubtotal ?? existing?.free_delivery_min_subtotal ?? null,
			whatsapp_templates: JSON.stringify(
				input.whatsappTemplates ?? parseJsonRecord(existing?.whatsapp_templates),
			),
			booking_enabled:
				input.bookingEnabled === undefined
					? (existing?.booking_enabled ?? 0)
					: input.bookingEnabled
						? 1
						: 0,
			payment_gateway_enabled:
				input.paymentGatewayEnabled === undefined
					? (existing?.payment_gateway_enabled ?? 0)
					: input.paymentGatewayEnabled
						? 1
						: 0,
			payment_gateway_provider:
				input.paymentGatewayProvider ?? existing?.payment_gateway_provider ?? null,
			payment_gateway_environment:
				input.paymentGatewayEnvironment ?? existing?.payment_gateway_environment ?? "sandbox",
			payment_gateway_public_key:
				input.paymentGatewayPublicKey ?? existing?.payment_gateway_public_key ?? null,
			payment_gateway_secret_key: paymentGatewaySecretKey,
			payment_gateway_webhook_secret: paymentGatewayWebhookSecret,
			payment_gateway_return_url:
				input.paymentGatewayReturnUrl ?? existing?.payment_gateway_return_url ?? null,
			payment_gateway_webhook_url:
				input.paymentGatewayWebhookUrl ?? existing?.payment_gateway_webhook_url ?? null,
			updated_at: new Date().toISOString(),
		};
		await db
			.insertInto("_emdash_shop_settings")
			.values({ id: DEFAULT_SETTINGS_ID, ...values })
			.onConflict((conflict) => conflict.column("id").doUpdateSet(values))
			.execute();
		return handleShopSettingsGet(db);
	} catch {
		return {
			success: false,
			error: { code: "SHOP_SETTINGS_UPDATE_ERROR", message: "Failed to update shop settings" },
		};
	}
}

export async function resolveShopPaymentGatewayCredentials(
	db: Kysely<Database>,
): Promise<ShopPaymentGatewayCredentials | null> {
	const row = await db
		.selectFrom("_emdash_shop_settings")
		.select([
			"payment_gateway_enabled",
			"payment_gateway_provider",
			"payment_gateway_environment",
			"payment_gateway_public_key",
			"payment_gateway_secret_key",
			"payment_gateway_webhook_secret",
			"payment_gateway_return_url",
			"payment_gateway_webhook_url",
		])
		.where("id", "=", DEFAULT_SETTINGS_ID)
		.executeTakeFirst();
	if (!row?.payment_gateway_enabled || !row.payment_gateway_provider) return null;
	return {
		provider: row.payment_gateway_provider,
		environment: row.payment_gateway_environment === "production" ? "production" : "sandbox",
		publicKey: row.payment_gateway_public_key,
		secretKey: row.payment_gateway_secret_key
			? await decryptShopSecret(row.payment_gateway_secret_key)
			: null,
		webhookSecret: row.payment_gateway_webhook_secret
			? await decryptShopSecret(row.payment_gateway_webhook_secret)
			: null,
		returnUrl: row.payment_gateway_return_url,
		webhookUrl: row.payment_gateway_webhook_url,
	};
}

export async function handleShopDeliveryZoneList(
	db: Kysely<Database>,
): Promise<ApiResult<ShopDeliveryZone[]>> {
	try {
		const rows = await db
			.selectFrom("_emdash_shop_delivery_zones")
			.selectAll()
			.orderBy("active", "desc")
			.orderBy("name", "asc")
			.execute();
		return { success: true, data: rows.map(toDeliveryZone) };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_DELIVERY_ZONE_LIST_ERROR", message: "Failed to list delivery zones" },
		};
	}
}

export interface ShopDeliveryZoneInput {
	name: string;
	districts: string[];
	deliveryCost: number;
	estimatedTime?: string | null;
	active?: boolean;
}

export async function handleShopDeliveryZoneCreate(
	db: Kysely<Database>,
	input: ShopDeliveryZoneInput,
): Promise<ApiResult<ShopDeliveryZone>> {
	try {
		const id = ulid();
		await db
			.insertInto("_emdash_shop_delivery_zones")
			.values({
				id,
				name: input.name,
				districts: JSON.stringify(input.districts),
				delivery_cost: input.deliveryCost,
				estimated_time: input.estimatedTime ?? null,
				active: input.active === false ? 0 : 1,
			})
			.execute();
		const row = await db
			.selectFrom("_emdash_shop_delivery_zones")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return { success: true, data: toDeliveryZone(row) };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_DELIVERY_ZONE_CREATE_ERROR", message: "Failed to create delivery zone" },
		};
	}
}

export async function handleShopDeliveryZoneUpdate(
	db: Kysely<Database>,
	id: string,
	input: Partial<ShopDeliveryZoneInput>,
): Promise<ApiResult<ShopDeliveryZone>> {
	try {
		const values = {
			...(input.name === undefined ? {} : { name: input.name }),
			...(input.districts === undefined ? {} : { districts: JSON.stringify(input.districts) }),
			...(input.deliveryCost === undefined ? {} : { delivery_cost: input.deliveryCost }),
			...(input.estimatedTime === undefined ? {} : { estimated_time: input.estimatedTime }),
			...(input.active === undefined ? {} : { active: input.active ? 1 : 0 }),
			updated_at: new Date().toISOString(),
		};
		await db.updateTable("_emdash_shop_delivery_zones").set(values).where("id", "=", id).execute();
		const row = await db
			.selectFrom("_emdash_shop_delivery_zones")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row)
			return {
				success: false,
				error: { code: "SHOP_DELIVERY_ZONE_NOT_FOUND", message: "Delivery zone not found" },
			};
		return { success: true, data: toDeliveryZone(row) };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_DELIVERY_ZONE_UPDATE_ERROR", message: "Failed to update delivery zone" },
		};
	}
}

export async function handleShopDeliveryZoneDelete(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<null>> {
	try {
		await db.deleteFrom("_emdash_shop_delivery_zones").where("id", "=", id).execute();
		return { success: true, data: null };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_DELIVERY_ZONE_DELETE_ERROR", message: "Failed to delete delivery zone" },
		};
	}
}

export async function handleShopProductList(db: Kysely<Database>): Promise<ApiResult<unknown[]>> {
	return handleShopCollectionList(db, PRODUCTS_COLLECTION, "product");
}

export async function handleShopServiceList(db: Kysely<Database>): Promise<ApiResult<unknown[]>> {
	return handleShopCollectionList(db, SERVICES_COLLECTION, "service");
}

async function handleShopCollectionList(
	db: Kysely<Database>,
	collection: ShopCollection,
	taxonomyPrefix: "product" | "service",
): Promise<ApiResult<unknown[]>> {
	try {
		const result = await new ContentRepository(db).findMany(collection, {
			limit: 100,
			where: { status: "published" },
		});
		const products = result.items.filter((item) => isProductAvailable(item.data));
		if (products.length === 0) return { success: true, data: products };

		const entryIds = products.map((product) => product.translationGroup ?? product.id);
		const termRows = await db
			.selectFrom("content_taxonomies")
			.innerJoin("taxonomies", "taxonomies.translation_group", "content_taxonomies.taxonomy_id")
			.select([
				"content_taxonomies.entry_id as entryId",
				"taxonomies.name as taxonomy",
				"taxonomies.slug as slug",
				"taxonomies.label as label",
			])
			.where("content_taxonomies.collection", "=", collection)
			.where("content_taxonomies.entry_id", "in", entryIds)
			.where("taxonomies.name", "in", [`${taxonomyPrefix}_category`, `${taxonomyPrefix}_tag`])
			.orderBy("taxonomies.label", "asc")
			.execute();
		const termsByEntry = new Map<string, Record<string, Array<{ slug: string; label: string }>>>();
		for (const row of termRows) {
			const terms = termsByEntry.get(row.entryId) ?? {};
			const termType = row.taxonomy.endsWith("_category") ? "category" : "tag";
			(terms[termType] ??= []).push({ slug: row.slug, label: row.label });
			termsByEntry.set(row.entryId, terms);
		}
		return {
			success: true,
			data: products.map((product) => ({
				...product,
				data: {
					...product.data,
					terms: termsByEntry.get(product.translationGroup ?? product.id) ?? {},
				},
			})),
		};
	} catch {
		return {
			success: false,
			error: {
				code: taxonomyPrefix === "product" ? "SHOP_PRODUCT_LIST_ERROR" : "SHOP_SERVICE_LIST_ERROR",
				message:
					taxonomyPrefix === "product"
						? "Failed to list shop products"
						: "Failed to list shop services",
			},
		};
	}
}

export async function handleShopProductRelatedList(
	db: Kysely<Database>,
	id: string,
	options: { limit?: number; strategy?: "both" | "category" | "tag" } = {},
): Promise<ApiResult<unknown[]>> {
	try {
		const productsResult = await handleShopProductList(db);
		if (!productsResult.success) return productsResult;
		const products = productsResult.data.filter(isRelatedProduct);
		const current = products.find((product) => product.id === id || product.slug === id);
		if (!current) return { success: true, data: [] };

		const terms = isRecord(current.data?.terms) ? current.data.terms : {};
		const strategy = options.strategy ?? "both";
		const categories = new Set(strategy === "tag" ? [] : termSlugs(terms.category));
		const tags = new Set(strategy === "category" ? [] : termSlugs(terms.tag));
		if (categories.size === 0 && tags.size === 0) return { success: true, data: [] };

		const limit = Math.min(Math.max(options.limit ?? 4, 1), 12);
		const related = products
			.filter((product) => product.id !== current.id)
			.map((product, index) => {
				const productTerms = product.data?.terms;
				const productTermRecord = isRecord(productTerms) ? productTerms : {};
				const categoryMatches = termSlugs(productTermRecord.category).filter((slug) =>
					categories.has(slug),
				).length;
				const tagMatches = termSlugs(productTermRecord.tag).filter((slug) => tags.has(slug)).length;
				return { product, score: categoryMatches * 2 + tagMatches, index };
			})
			.filter((item) => item.score > 0)
			.toSorted((a, b) => b.score - a.score || a.index - b.index)
			.slice(0, limit)
			.map((item) => item.product);
		return { success: true, data: related };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_PRODUCT_RELATED_ERROR", message: "Failed to list related products" },
		};
	}
}

function termSlugs(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((term) => {
		if (!isRecord(term)) return [];
		const slug = term.slug;
		return typeof slug === "string" ? [slug] : [];
	});
}

function isRelatedProduct(value: unknown): value is {
	id?: string;
	slug?: string | null;
	data?: Record<string, unknown>;
} {
	if (!isRecord(value)) return false;
	return (
		(value.id === undefined || typeof value.id === "string") &&
		(value.slug === undefined || value.slug === null || typeof value.slug === "string") &&
		(value.data === undefined || isRecord(value.data))
	);
}

export async function handleShopProductGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<unknown>> {
	try {
		const product = await new ContentRepository(db).findByIdOrSlug(PRODUCTS_COLLECTION, id);
		if (!product || product.status !== "published" || !isProductAvailable(product.data)) {
			return {
				success: false,
				error: { code: "SHOP_PRODUCT_NOT_FOUND", message: "Product not found" },
			};
		}
		return { success: true, data: product };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_PRODUCT_GET_ERROR", message: "Failed to get shop product" },
		};
	}
}

export async function handleShopServiceGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<unknown>> {
	try {
		const service = await new ContentRepository(db).findByIdOrSlug(SERVICES_COLLECTION, id);
		if (!service || service.status !== "published" || !isProductAvailable(service.data)) {
			return {
				success: false,
				error: { code: "SHOP_SERVICE_NOT_FOUND", message: "Service not found" },
			};
		}
		return { success: true, data: service };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_SERVICE_GET_ERROR", message: "Failed to get shop service" },
		};
	}
}

export async function handleShopOrderCreate(
	db: Kysely<Database>,
	input: ShopOrderInput,
): Promise<ApiResult<ShopOrderSummary>> {
	try {
		let checkoutItems = input.items;
		if (input.cartToken && checkoutItems.length === 0) {
			const digest = await shopCartTokenHash(input.cartToken);
			const cart = await db
				.selectFrom("_emdash_shop_carts")
				.select("id")
				.where("guest_token_hash", "=", digest)
				.where("status", "=", "active")
				.where("expires_at", ">", new Date().toISOString())
				.executeTakeFirst();
			if (!cart)
				return {
					success: false,
					error: { code: "SHOP_CART_NOT_FOUND", message: "Cart not found" },
				};
			const cartItems = await db
				.selectFrom("_emdash_shop_cart_items")
				.selectAll()
				.where("cart_id", "=", cart.id)
				.orderBy("created_at", "asc")
				.execute();
			checkoutItems = cartItems.map((item) => ({
				productId: item.product_id,
				collection: normalizeShopCollection(item.collection),
				variantId: item.variant_id ?? undefined,
				quantity: item.quantity,
			}));
		}
		const settingsResult = await handleShopSettingsGet(db);
		if (!settingsResult.success) return settingsResult;
		const settings = settingsResult.data;
		if (checkoutItems.length === 0)
			return {
				success: false,
				error: { code: "SHOP_ORDER_EMPTY", message: "Order must contain at least one product" },
			};

		const products = new ContentRepository(db);
		const requestedQuantities = new Map<
			string,
			{
				productId: string;
				collection: ShopCollection;
				variantId?: string;
				quantity: number;
				booking?: ShopOrderInput["items"][number]["booking"];
				openEnrollment?: boolean;
			}
		>();
		for (const inputItem of checkoutItems) {
			const collection =
				inputItem.collection ?? (inputItem.booking ? SERVICES_COLLECTION : PRODUCTS_COLLECTION);
			const key = `${collection}:${inputItem.productId}:${inputItem.variantId ?? ""}:${inputItem.booking?.reservationId ?? ""}`;
			const current = requestedQuantities.get(key);
			requestedQuantities.set(key, {
				productId: inputItem.productId,
				collection,
				variantId: inputItem.variantId,
				quantity: (current?.quantity ?? 0) + inputItem.quantity,
				booking: inputItem.booking,
			});
		}
		const items = [] as Array<{
			productId: string;
			collection: ShopCollection;
			productName: string;
			unitPrice: number;
			quantity: number;
			discount: number;
			subtotal: number;
			variantId: string | null;
			variantName: string | null;
			booking?: ShopOrderInput["items"][number]["booking"];
			openEnrollment: boolean;
			openEnrollmentCapacity: number | null;
		}>;
		for (const requested of requestedQuantities.values()) {
			const product = await products.findByIdOrSlug(requested.collection, requested.productId);
			if (!product || product.status !== "published" || !isProductAvailable(product.data)) {
				return {
					success: false,
					error: {
						code:
							requested.collection === SERVICES_COLLECTION
								? "SHOP_SERVICE_UNAVAILABLE"
								: "SHOP_PRODUCT_UNAVAILABLE",
						message:
							requested.collection === SERVICES_COLLECTION
								? "Service is not available"
								: "Product is not available",
					},
				};
			}
			if (requested.collection === PRODUCTS_COLLECTION && isService(product.data)) {
				return {
					success: false,
					error: {
						code: "SHOP_SERVICE_COLLECTION_REQUIRED",
						message: "Services must use the services collection",
					},
				};
			}
			if (requested.collection === SERVICES_COLLECTION && !isService(product.data)) {
				return {
					success: false,
					error: {
						code: "SHOP_PRODUCT_COLLECTION_REQUIRED",
						message: "Products must use the products collection",
					},
				};
			}
			const bookableService = isBookableService(product.data);
			const openEnrollment = isOpenEnrollmentService(product.data);
			if (bookableService && !openEnrollment && !requested.booking) {
				return {
					success: false,
					error: {
						code: "SHOP_BOOKING_REQUIRED",
						message: "A booking is required for this service",
					},
				};
			}
			if (!bookableService && requested.booking) {
				return {
					success: false,
					error: { code: "SHOP_BOOKING_INVALID", message: "Booking is only valid for services" },
				};
			}
			const variants = productVariants(product.data);
			const variant = requested.variantId
				? variants.find((item) => (item.id ?? item.label) === requested.variantId)
				: undefined;
			if (requested.variantId && !variant) {
				return {
					success: false,
					error: { code: "SHOP_VARIANT_NOT_FOUND", message: "Product variation not found" },
				};
			}
			const price =
				variant && typeof variant.price === "number" && variant.price >= 0
					? { price: variant.price, discount: 0 }
					: productPrice(product.data);
			const stock = variant?.stock ?? product.data.stock;
			if (!price || !Number.isInteger(requested.quantity) || requested.quantity < 1) {
				return {
					success: false,
					error: { code: "SHOP_PRODUCT_INVALID", message: "Product price or quantity is invalid" },
				};
			}
			if (!isBookableService && typeof stock === "number" && requested.quantity > stock) {
				return {
					success: false,
					error: {
						code: "SHOP_STOCK_UNAVAILABLE",
						message: "Requested quantity exceeds available stock",
					},
				};
			}
			const productName =
				typeof product.data.name === "string" ? product.data.name : product.slug || product.id;
			items.push({
				productId: product.id,
				collection: requested.collection,
				productName: variant?.label ? `${productName} (${variant.label})` : productName,
				unitPrice: price.price,
				quantity: requested.quantity,
				discount: price.discount * requested.quantity,
				subtotal: price.price * requested.quantity,
				variantId: requested.variantId ?? null,
				variantName: null,
				booking: requested.booking,
				openEnrollment,
				openEnrollmentCapacity: openEnrollment ? serviceCapacity(product.data) : null,
			});
		}
		const hasPhysicalItems = items.some((item) => item.collection === PRODUCTS_COLLECTION);
		const zone = input.deliveryZoneId
			? await db
					.selectFrom("_emdash_shop_delivery_zones")
					.selectAll()
					.where("id", "=", input.deliveryZoneId)
					.where("active", "=", 1)
					.executeTakeFirst()
			: undefined;
		if (hasPhysicalItems && !zone) {
			return {
				success: false,
				error: { code: "SHOP_DELIVERY_ZONE_NOT_FOUND", message: "Delivery zone not found" },
			};
		}

		const subtotal = items.reduce((sum, item) => sum + item.subtotal, 0);
		const discount = items.reduce((sum, item) => sum + item.discount, 0);
		if (subtotal < settings.minimumSubtotal) {
			return {
				success: false,
				error: {
					code: "SHOP_MINIMUM_SUBTOTAL",
					message: "Order subtotal is below the shop minimum",
					details: { minimumSubtotal: settings.minimumSubtotal },
				},
			};
		}
		const couponRow = input.couponCode
			? await db
					.selectFrom("_emdash_shop_coupons")
					.selectAll()
					.where("code", "=", normalizeCouponCode(input.couponCode))
					.executeTakeFirst()
			: undefined;
		const coupon = couponRow ? toCoupon(couponRow) : null;
		if (input.couponCode && !coupon)
			return {
				success: false,
				error: { code: "SHOP_COUPON_INVALID", message: "Coupon is invalid" },
			};
		if (coupon) {
			const reason = couponIsUsable(coupon, subtotal);
			if (reason)
				return { success: false, error: { code: "SHOP_COUPON_INVALID", message: reason } };
		}
		const couponDiscountAmount = coupon ? couponDiscount(coupon, subtotal) : 0;
		const couponCode = coupon?.code ?? null;
		const deliveryCost =
			settings.freeDeliveryMinSubtotal !== null &&
			settings.freeDeliveryMinSubtotal >= 0 &&
			subtotal >= settings.freeDeliveryMinSubtotal
				? 0
				: (zone?.delivery_cost ?? 0);
		const orderNumber = makeOrderNumber();
		const orderId = ulid();
		const customerId = ulid();
		const orderItemRows = items.map((item) => ({
			id: ulid(),
			order_id: orderId,
			product_id: item.productId,
			collection: item.collection,
			variant_id: item.variantId,
			product_name: item.productName,
			variant_name: item.variantName,
			unit_price: item.unitPrice,
			quantity: item.quantity,
			discount: item.discount,
			subtotal: item.subtotal,
		}));
		const inventoryMovements: Array<{
			product_id: string;
			variant_id: string | null;
			order_id: string;
			order_item_id: string;
			type: string;
			quantity_delta: number;
			reference_type: string;
			reference_id: string;
			event_key: string;
		}> = [];
		const firstName = input.customer.firstName.trim();
		const lastName = input.customer.lastName.trim();
		const customerName = `${firstName} ${lastName}`;
		const customerSnapshot = {
			...input.customer,
			firstName,
			lastName,
			name: customerName,
		};
		const deliverySnapshot = {
			zoneId: zone?.id ?? null,
			zone: zone?.name ?? null,
			address: input.customer.address ?? null,
			district: input.customer.district ?? null,
			reference: input.customer.reference ?? null,
			phone: input.customer.phone,
			recipientName: input.recipientName ?? customerName,
			recipientPhone: input.recipientPhone ?? input.customer.phone,
			scheduledDate: input.deliveryDate ?? null,
			scheduledTime: input.deliveryTime ?? null,
			instructions: input.deliveryInstructions ?? null,
		};

		await withTransaction(db, async (trx) => {
			if (input.cartToken) {
				const cart = await trx
					.selectFrom("_emdash_shop_carts")
					.select("id")
					.where("guest_token_hash", "=", await shopCartTokenHash(input.cartToken))
					.where("status", "=", "active")
					.where("expires_at", ">", new Date().toISOString())
					.executeTakeFirst();
				if (!cart) throw new Error("SHOP_CART_NOT_FOUND");
				await trx
					.updateTable("_emdash_shop_carts")
					.set({
						status: "converted",
						converted_order_id: orderId,
						updated_at: new Date().toISOString(),
					})
					.where("id", "=", cart.id)
					.execute();
			}
			if (coupon) {
				const updatedCoupon = await trx
					.updateTable("_emdash_shop_coupons")
					.set({ usage_count: sql`usage_count + 1`, updated_at: new Date().toISOString() })
					.where("id", "=", coupon.id)
					.where("active", "=", 1)
					.where((eb) =>
						eb.or([eb("usage_limit", "is", null), eb("usage_count", "<", eb.ref("usage_limit"))]),
					)
					.executeTakeFirst();
				if (Number(updatedCoupon.numUpdatedRows) !== 1) throw new ShopCouponError();
			}
			for (const item of items) {
				if (!item.openEnrollment || item.openEnrollmentCapacity === null) continue;
				const activeEnrollment = await trx
					.selectFrom("_emdash_shop_enrollments")
					.select(({ fn }) => fn.sum("quantity").as("quantity"))
					.where("service_id", "=", item.productId)
					.where("status", "in", ["pending_schedule", "scheduled"])
					.executeTakeFirst();
				if (Number(activeEnrollment?.quantity ?? 0) + item.quantity > item.openEnrollmentCapacity) {
					throw new ShopCapacityError();
				}
			}
			for (const [itemIndex, item] of items.entries()) {
				if (item.collection !== PRODUCTS_COLLECTION) continue;
				if (item.variantId) {
					const currentProduct = await new ContentRepository(trx).findById(
						PRODUCTS_COLLECTION,
						item.productId,
					);
					const currentVariants = currentProduct ? productVariants(currentProduct.data) : [];
					const currentVariant = currentVariants.find(
						(variant) => (variant.id ?? variant.label) === item.variantId,
					);
					const currentStock = currentVariant?.stock;
					if (!currentProduct || !currentVariant) {
						throw new ShopStockError();
					}
					if (typeof currentStock === "number") {
						if (currentStock < item.quantity) throw new ShopStockError();
						const updatedVariants = currentVariants.map((variant) =>
							(variant.id ?? variant.label) === item.variantId
								? { ...variant, stock: currentStock - item.quantity }
								: variant,
						);
						await new ContentRepository(trx).update(PRODUCTS_COLLECTION, item.productId, {
							data: { ...currentProduct.data, variants: updatedVariants },
						});
						inventoryMovements.push({
							product_id: item.productId,
							variant_id: item.variantId,
							order_id: orderId,
							order_item_id: orderItemRows[itemIndex]?.id ?? "",
							type: "sale",
							quantity_delta: -item.quantity,
							reference_type: "order",
							reference_id: orderId,
							event_key: `sale:${orderId}:${orderItemRows[itemIndex]?.id ?? ""}`,
						});
						continue;
					}
				}
				const updated = await sql`
					UPDATE ${sql.ref("ec_products")}
					SET ${sql.ref("stock")} = ${sql.ref("stock")} - ${item.quantity},
						${sql.ref("updated_at")} = ${new Date().toISOString()},
						${sql.ref("version")} = ${sql.ref("version")} + 1
					WHERE ${sql.ref("id")} = ${item.productId}
						AND ${sql.ref("stock")} >= ${item.quantity}
				`.execute(trx);
				if (Number(updated.numAffectedRows) !== 1) throw new ShopStockError();
				inventoryMovements.push({
					product_id: item.productId,
					variant_id: null,
					order_id: orderId,
					order_item_id: orderItemRows[itemIndex]?.id ?? "",
					type: "sale",
					quantity_delta: -item.quantity,
					reference_type: "order",
					reference_id: orderId,
					event_key: `sale:${orderId}:${orderItemRows[itemIndex]?.id ?? ""}`,
				});
			}
			await trx
				.insertInto("_emdash_shop_customers")
				.values({
					id: customerId,
					name: customerName,
					first_name: firstName,
					last_name: lastName,
					phone: input.customer.phone,
					email: input.customer.email ?? null,
					address: input.customer.address,
					district: input.customer.district,
					reference: input.customer.reference ?? null,
					document_type: input.customer.documentType ?? null,
					document_number: input.customer.documentNumber ?? null,
					fiscal_name: input.customer.fiscalName ?? null,
					fiscal_address: input.customer.fiscalAddress ?? null,
				})
				.execute();
			await trx
				.insertInto("_emdash_shop_orders")
				.values({
					id: orderId,
					order_number: orderNumber,
					customer_id: customerId,
					currency: settings.currency,
					subtotal,
					discount,
					coupon_code: couponCode,
					coupon_discount: couponDiscountAmount,
					delivery_cost: deliveryCost,
					total: subtotal - couponDiscountAmount + deliveryCost,
					customer_snapshot: JSON.stringify(customerSnapshot),
					delivery_snapshot: JSON.stringify(deliverySnapshot),
					notes: input.notes ?? null,
				})
				.execute();
			await trx.insertInto("_emdash_shop_order_items").values(orderItemRows).execute();
			if (inventoryMovements.length > 0) {
				await trx
					.insertInto("_emdash_shop_inventory_movements")
					.values(inventoryMovements.map((movement) => ({ id: ulid(), ...movement })))
					.execute();
			}
			for (const [index, item] of items.entries()) {
				if (item.collection !== SERVICES_COLLECTION) continue;
				const orderItemId = orderItemRows[index]?.id ?? null;
				if (item.openEnrollment) {
					await trx
						.insertInto("_emdash_shop_enrollments")
						.values({
							id: ulid(),
							service_id: item.productId,
							order_id: orderId,
							order_item_id: orderItemId,
							customer_id: customerId,
							quantity: item.quantity,
							starts_at: null,
							ends_at: null,
							status: "pending_schedule",
							customer_snapshot: JSON.stringify(customerSnapshot),
							service_snapshot: JSON.stringify({
								id: item.productId,
								name: item.productName,
								capacity: item.openEnrollmentCapacity,
							}),
							notes: input.notes ?? null,
						})
						.execute();
					continue;
				}
				if (!item.booking) continue;
				const updatedReservation = await trx
					.updateTable("_emdash_shop_reservations")
					.set({
						order_id: orderId,
						order_item_id: orderItemId,
						status: "pending_payment",
						expires_at: null,
						updated_at: new Date().toISOString(),
					})
					.where("id", "=", item.booking.reservationId)
					.where("service_id", "=", item.productId)
					.where("status", "=", "held")
					.where("starts_at", "=", item.booking.startsAt)
					.where("ends_at", "=", item.booking.endsAt)
					.executeTakeFirst();
				if (Number(updatedReservation.numUpdatedRows ?? 0) !== 1)
					throw new Error("BOOKING_UNAVAILABLE");
			}
			await trx
				.insertInto("_emdash_shop_payments")
				.values({
					id: ulid(),
					order_id: orderId,
					method: input.paymentMethod,
					amount: subtotal - couponDiscountAmount + deliveryCost,
				})
				.execute();
			if (zone)
				await trx
					.insertInto("_emdash_shop_deliveries")
					.values({
						id: ulid(),
						order_id: orderId,
						zone: zone.name,
						address: input.customer.address ?? "",
						district: input.customer.district ?? "",
						reference: input.customer.reference ?? null,
						phone: input.customer.phone,
						delivery_cost: deliveryCost,
						scheduled_date: input.deliveryDate ?? null,
						scheduled_time: input.deliveryTime ?? null,
						recipient_name: input.recipientName ?? customerName,
						recipient_phone: input.recipientPhone ?? input.customer.phone,
						instructions: input.deliveryInstructions ?? null,
					})
					.execute();
		});
		invalidateCollectionCache(PRODUCTS_COLLECTION);
		invalidateCollectionCache(SERVICES_COLLECTION);

		return {
			success: true,
			data: {
				id: orderId,
				orderNumber,
				status: "new",
				paymentStatus: "pending",
				deliveryStatus: "pending",
				currency: settings.currency,
				currencySymbol: settings.currencySymbol,
				subtotal,
				discount,
				deliveryCost,
				total: subtotal - couponDiscountAmount + deliveryCost,
				couponCode,
				couponDiscount: couponDiscountAmount,
				whatsappUrl: makeWhatsAppUrl(
					settings.whatsappNumber,
					{
						id: orderId,
						orderNumber,
						status: "new",
						paymentStatus: "pending",
						deliveryStatus: "pending",
						currency: settings.currency,
						currencySymbol: settings.currencySymbol,
						subtotal,
						discount,
						deliveryCost,
						total: subtotal - couponDiscountAmount + deliveryCost,
						couponCode,
						couponDiscount: couponDiscountAmount,
						whatsappUrl: null,
						items: items.map((item) => ({
							id: "",
							productId: item.productId,
							variantId: item.variantId,
							productName: item.productName,
							variantName: item.variantName,
							unitPrice: item.unitPrice,
							quantity: item.quantity,
							discount: item.discount,
							subtotal: item.subtotal,
						})),
					},
					settings,
					customerSnapshot,
					deliverySnapshot,
				),
			},
		};
	} catch (error) {
		if (error instanceof ShopStockError) {
			return {
				success: false,
				error: {
					code: "SHOP_STOCK_UNAVAILABLE",
					message: "Requested quantity is no longer available",
				},
			};
		}
		if (error instanceof ShopCouponError) {
			return {
				success: false,
				error: { code: "SHOP_COUPON_INVALID", message: "Coupon is no longer available" },
			};
		}
		if (error instanceof ShopCapacityError) {
			return {
				success: false,
				error: {
					code: "SHOP_SERVICE_CAPACITY_REACHED",
					message: "Service capacity has been reached",
				},
			};
		}
		return {
			success: false,
			error: { code: "SHOP_ORDER_CREATE_ERROR", message: "Failed to create order" },
		};
	}
}

export async function handleShopOrderList(
	db: Kysely<Database>,
): Promise<ApiResult<ShopOrderSummary[]>> {
	try {
		const [rows, settings] = await Promise.all([
			db
				.selectFrom("_emdash_shop_orders")
				.selectAll()
				.orderBy("created_at", "desc")
				.limit(100)
				.execute(),
			handleShopSettingsGet(db),
		]);
		if (!settings.success) return settings;
		return {
			success: true,
			data: rows.map((row) => ({
				id: row.id,
				orderNumber: row.order_number,
				status: row.status,
				paymentStatus: row.payment_status,
				deliveryStatus: row.delivery_status,
				currency: row.currency,
				currencySymbol: settings.data.currencySymbol,
				subtotal: row.subtotal,
				discount: row.discount,
				deliveryCost: row.delivery_cost,
				total: row.total,
				whatsappUrl: null,
				couponCode: row.coupon_code,
				couponDiscount: row.coupon_discount,
			})),
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_ORDER_LIST_ERROR", message: "Failed to list orders" },
		};
	}
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

export async function handleShopCustomerList(
	db: Kysely<Database>,
): Promise<ApiResult<ShopCustomerSummary[]>> {
	try {
		const [rows, orders] = await Promise.all([
			db
				.selectFrom("_emdash_shop_customers")
				.selectAll()
				.orderBy("created_at", "desc")
				.limit(100)
				.execute(),
			db
				.selectFrom("_emdash_shop_orders")
				.select(["customer_id", "order_number", "status", "total", "created_at"])
				.orderBy("created_at", "desc")
				.limit(500)
				.execute(),
		]);
		const ordersByCustomer = new Map<string, typeof orders>();
		for (const order of orders) {
			const customerOrders = ordersByCustomer.get(order.customer_id) ?? [];
			customerOrders.push(order);
			ordersByCustomer.set(order.customer_id, customerOrders);
		}
		return {
			success: true,
			data: rows.map((row) => ({
				id: row.id,
				name: row.name,
				phone: row.phone,
				email: row.email,
				address: row.address,
				district: row.district,
				reference: row.reference,
				notes: row.notes,
				createdAt: row.created_at ?? null,
				updatedAt: row.updated_at ?? null,
				orderCount: ordersByCustomer.get(row.id)?.length ?? 0,
				totalSpent: (ordersByCustomer.get(row.id) ?? []).reduce(
					(sum, order) => sum + order.total,
					0,
				),
				lastOrderNumber: ordersByCustomer.get(row.id)?.[0]?.order_number ?? null,
				lastOrderStatus: ordersByCustomer.get(row.id)?.[0]?.status ?? null,
				lastOrderCreatedAt: ordersByCustomer.get(row.id)?.[0]?.created_at ?? null,
				orders: (ordersByCustomer.get(row.id) ?? []).map((order) => ({
					orderNumber: order.order_number,
					status: order.status,
					total: order.total,
					createdAt: order.created_at ?? null,
				})),
			})),
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_CUSTOMER_LIST_ERROR", message: "Failed to list customers" },
		};
	}
}

export async function handleShopOrderGet(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<ShopOrderDetail>> {
	try {
		const order = await db
			.selectFrom("_emdash_shop_orders")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		if (!order)
			return {
				success: false,
				error: { code: "SHOP_ORDER_NOT_FOUND", message: "Order not found" },
			};
		const [items, settings] = await Promise.all([
			db
				.selectFrom("_emdash_shop_order_items")
				.selectAll()
				.where("order_id", "=", id)
				.orderBy("created_at", "asc")
				.execute(),
			handleShopSettingsGet(db),
		]);
		if (!settings.success) return settings;
		const customer = parseJsonRecord(order.customer_snapshot);
		const deliveryRecord = await db
			.selectFrom("_emdash_shop_deliveries")
			.select(["tracking_code", "tracking_url"])
			.where("order_id", "=", id)
			.executeTakeFirst();
		const delivery = {
			...parseJsonRecord(order.delivery_snapshot),
			trackingCode: deliveryRecord?.tracking_code ?? null,
			trackingUrl: deliveryRecord?.tracking_url ?? null,
		};
		const summary = {
			id: order.id,
			orderNumber: order.order_number,
			status: order.status,
			paymentStatus: order.payment_status,
			deliveryStatus: order.delivery_status,
			currency: order.currency,
			currencySymbol: settings.data.currencySymbol,
			subtotal: order.subtotal,
			discount: order.discount,
			deliveryCost: order.delivery_cost,
			total: order.total,
			whatsappUrl: null,
		};
		const detail: ShopOrderDetail = {
			...summary,
			items: items.map((item) => ({
				id: item.id,
				productId: item.product_id,
				collection: normalizeShopCollection(item.collection),
				variantId: item.variant_id,
				productName: item.product_name,
				variantName: item.variant_name,
				unitPrice: item.unit_price,
				quantity: item.quantity,
				discount: item.discount,
				subtotal: item.subtotal,
			})),
			customer,
			delivery,
			notes: order.notes,
		};
		const phone = typeof customer.phone === "string" ? customer.phone : null;
		detail.whatsappUrl = makeWhatsAppUrl(phone, detail, settings.data, customer, delivery);
		return { success: true, data: detail };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_ORDER_GET_ERROR", message: "Failed to get order" },
		};
	}
}

export async function handleShopOrderGetByNumber(
	db: Kysely<Database>,
	orderNumber: string,
): Promise<ApiResult<ShopOrderDetail>> {
	try {
		const decodedOrderNumber = decodeURIComponent(orderNumber).trim();
		const normalizedOrderNumber = decodedOrderNumber.startsWith("#")
			? decodedOrderNumber
			: `#${decodedOrderNumber}`;
		const order = await db
			.selectFrom("_emdash_shop_orders")
			.select("id")
			.where("order_number", "=", normalizedOrderNumber)
			.executeTakeFirst();
		if (!order)
			return {
				success: false,
				error: { code: "SHOP_ORDER_NOT_FOUND", message: "Order not found" },
			};
		const detail = await handleShopOrderGet(db, order.id);
		if (!detail.success) return detail;
		const repository = new ContentRepository(db);
		const publicItems = await Promise.all(
			detail.data.items.map(async (item) => {
				const product = await repository.findById(item.collection, item.productId);
				const variants =
					product && Array.isArray(product.data.variants) ? product.data.variants : [];
				const selectedVariant = variants.find(
					(variant) => isRecord(variant) && (variant.id ?? variant.label) === item.variantId,
				);
				const image =
					isRecord(selectedVariant) && selectedVariant.image
						? selectedVariant.image
						: product?.data.featured_image;
				const imageRecord = isRecord(image) ? image : null;
				const imageSrc = getStringField(imageRecord, "src");
				const storageKey = getStringField(imageRecord?.meta, "storageKey");
				const imageId = getStringField(imageRecord, "id");
				const imageUrl = imageSrc
					? imageSrc
					: storageKey
						? `/_emdash/api/media/file/${storageKey}`
						: imageId
							? `/_emdash/api/media/file/${imageId}`
							: null;
				return { ...item, imageUrl };
			}),
		);
		return {
			success: true,
			data: { ...detail.data, items: publicItems, customer: {}, delivery: {}, notes: null },
		};
	} catch {
		return {
			success: false,
			error: { code: "SHOP_ORDER_LOOKUP_ERROR", message: "Failed to find order" },
		};
	}
}

export async function handleShopOrderWhatsAppUrl(
	db: Kysely<Database>,
	orderId: string,
	templateKey?: string,
): Promise<ApiResult<string>> {
	const orderResult = await handleShopOrderGet(db, orderId);
	if (!orderResult.success) return orderResult;
	const settingsResult = await handleShopSettingsGet(db);
	if (!settingsResult.success) return settingsResult;
	const order = orderResult.data;
	const customerPhone = typeof order.customer.phone === "string" ? order.customer.phone : null;
	const url = makeWhatsAppUrl(
		customerPhone,
		order,
		settingsResult.data,
		order.customer,
		order.delivery,
		templateKey,
	);
	return url
		? { success: true, data: url }
		: {
				success: false,
				error: { code: "SHOP_WHATSAPP_UNAVAILABLE", message: "WhatsApp is not configured" },
			};
}

export async function handleShopPaymentConfirm(
	db: Kysely<Database>,
	orderId: string,
	confirmedBy: string,
): Promise<ApiResult<null>> {
	try {
		const now = new Date().toISOString();
		await db
			.updateTable("_emdash_shop_orders")
			.set({ payment_status: "confirmed", status: "confirmed", updated_at: now })
			.where("id", "=", orderId)
			.execute();
		await db
			.updateTable("_emdash_shop_payments")
			.set({ status: "confirmed", confirmed_by: confirmedBy, confirmed_at: now })
			.where("order_id", "=", orderId)
			.execute();
		await db
			.updateTable("_emdash_shop_reservations")
			.set({ status: "confirmed", updated_at: now })
			.where("order_id", "=", orderId)
			.where("status", "=", "pending_payment")
			.execute();
		return { success: true, data: null };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_PAYMENT_CONFIRM_ERROR", message: "Failed to confirm payment" },
		};
	}
}

export async function handleShopOrderCancel(
	db: Kysely<Database>,
	orderId: string,
	reason: string,
): Promise<ApiResult<null>> {
	try {
		const order = await db
			.selectFrom("_emdash_shop_orders")
			.select(["id", "status"])
			.where("id", "=", orderId)
			.executeTakeFirst();
		if (!order) {
			return {
				success: false,
				error: { code: "SHOP_ORDER_NOT_FOUND", message: "Order not found" },
			};
		}
		if (order.status === "cancelled") return { success: true, data: null };
		if (["delivered", "in_transit"].includes(order.status)) {
			return {
				success: false,
				error: { code: "SHOP_ORDER_NOT_CANCELLABLE", message: "Order cannot be cancelled" },
			};
		}

		await withTransaction(db, async (trx) => {
			const now = new Date().toISOString();
			const updated = await trx
				.updateTable("_emdash_shop_orders")
				.set({ status: "cancelled", cancellation_reason: reason, updated_at: now })
				.where("id", "=", orderId)
				.where("status", "!=", "cancelled")
				.executeTakeFirst();
			if (Number(updated.numUpdatedRows) !== 1) return;

			const sales = await trx
				.selectFrom("_emdash_shop_inventory_movements")
				.selectAll()
				.where("order_id", "=", orderId)
				.where("type", "=", "sale")
				.execute();
			for (const sale of sales) {
				const eventKey = `cancellation:${orderId}:${sale.order_item_id ?? sale.id}`;
				const existing = await trx
					.selectFrom("_emdash_shop_inventory_movements")
					.select("id")
					.where("event_key", "=", eventKey)
					.executeTakeFirst();
				if (existing) continue;
				const quantity = Math.abs(sale.quantity_delta);
				if (sale.variant_id) {
					const product = await new ContentRepository(trx).findById(
						PRODUCTS_COLLECTION,
						sale.product_id,
					);
					const variants = product ? productVariants(product.data) : [];
					const variant = variants.find((item) => (item.id ?? item.label) === sale.variant_id);
					const variantStock = variant?.stock;
					if (!product || !variant || typeof variantStock !== "number") {
						throw new ShopStockError();
					}
					const updatedVariants = variants.map((item) =>
						(item.id ?? item.label) === sale.variant_id
							? { ...item, stock: variantStock + quantity }
							: item,
					);
					await new ContentRepository(trx).update(PRODUCTS_COLLECTION, sale.product_id, {
						data: { ...product.data, variants: updatedVariants },
					});
				} else {
					const updatedStock = await sql`
						UPDATE ${sql.ref("ec_products")}
						SET ${sql.ref("stock")} = ${sql.ref("stock")} + ${quantity},
							${sql.ref("updated_at")} = ${now},
							${sql.ref("version")} = ${sql.ref("version")} + 1
						WHERE ${sql.ref("id")} = ${sale.product_id}
							AND ${sql.ref("stock")} IS NOT NULL
					`.execute(trx);
					if (Number(updatedStock.numAffectedRows) !== 1) throw new ShopStockError();
				}
				await trx
					.insertInto("_emdash_shop_inventory_movements")
					.values({
						id: ulid(),
						product_id: sale.product_id,
						variant_id: sale.variant_id,
						order_id: orderId,
						order_item_id: sale.order_item_id,
						type: "cancellation",
						quantity_delta: quantity,
						reason,
						reference_type: "order",
						reference_id: orderId,
						event_key: eventKey,
					})
					.execute();
			}
			await trx
				.updateTable("_emdash_shop_deliveries")
				.set({ status: "cancelled", updated_at: now })
				.where("order_id", "=", orderId)
				.execute();
		});
		return { success: true, data: null };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_ORDER_CANCEL_ERROR", message: "Failed to cancel order" },
		};
	}
}

export async function handleShopDeliveryUpdate(
	db: Kysely<Database>,
	orderId: string,
	status: string,
	courierName?: string,
	trackingCode?: string | null,
	trackingUrl?: string | null,
	failedReason?: string | null,
	scheduledDate?: string | null,
	scheduledTime?: string | null,
	cancellationReason?: string | null,
): Promise<ApiResult<null>> {
	try {
		const now = new Date().toISOString();
		const existing = await db
			.selectFrom("_emdash_shop_deliveries")
			.select(["delivered_at", "rescheduled_at"])
			.where("order_id", "=", orderId)
			.executeTakeFirst();
		await db
			.updateTable("_emdash_shop_deliveries")
			.set({
				status,
				courier_name: courierName ?? null,
				tracking_code: trackingCode ?? null,
				tracking_url: trackingUrl ?? null,
				failed_reason: failedReason ?? null,
				scheduled_date: scheduledDate ?? null,
				scheduled_time: scheduledTime ?? null,
				delivered_at: status === "delivered" ? now : (existing?.delivered_at ?? null),
				rescheduled_at: status === "rescheduled" ? now : (existing?.rescheduled_at ?? null),
				updated_at: now,
			})
			.where("order_id", "=", orderId)
			.execute();
		const orderStatus =
			status === "delivered"
				? "delivered"
				: status === "in_transit"
					? "in_transit"
					: status === "not_delivered"
						? "not_delivered"
						: status === "cancelled"
							? "cancelled"
							: "ready";
		await db
			.updateTable("_emdash_shop_orders")
			.set({
				delivery_status: status,
				status: orderStatus,
				cancellation_reason: status === "cancelled" ? (cancellationReason ?? null) : undefined,
				updated_at: now,
			})
			.where("id", "=", orderId)
			.execute();
		return { success: true, data: null };
	} catch {
		return {
			success: false,
			error: { code: "SHOP_DELIVERY_UPDATE_ERROR", message: "Failed to update delivery" },
		};
	}
}
