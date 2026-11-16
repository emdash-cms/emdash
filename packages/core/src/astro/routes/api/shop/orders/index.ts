import type { APIRoute } from "astro";

import { apiError, handleError, requireDb, unwrapResult } from "#api/error.js";
import { handleShopOrderCreate } from "#api/handlers/shop.js";
import { isParseError, parseBody } from "#api/parse.js";
import { shopOrderCreateBody } from "#api/schemas.js";
import { checkRateLimit, getClientIp, rateLimitResponse } from "#auth/rate-limit.js";
import { getTrustedProxyHeaders } from "#auth/trusted-proxy.js";

function escapeEmailHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			'"': "&quot;",
			"'": "&#39;",
		};
		return entities[character] ?? character;
	});
}

function parseEmailTemplateRecord(json: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(json);
		if (!value || typeof value !== "object" || Array.isArray(value)) return null;
		return Object.fromEntries(Object.entries(value));
	} catch {
		return null;
	}
}

export async function sendOrderConfirmation(
	db: NonNullable<App.Locals["emdash"]>["db"],
	emdash: NonNullable<App.Locals["emdash"]>,
	order: {
		id: string;
		orderNumber: string;
		total: number;
		currency: string;
		trackingToken?: string;
	},
	requestUrl: string,
): Promise<void> {
	const storedOrder = await db
		.selectFrom("_emdash_shop_orders")
		.select("customer_snapshot")
		.where("id", "=", order.id)
		.executeTakeFirst();
	if (!storedOrder) return;
	const customer: unknown = JSON.parse(storedOrder.customer_snapshot);
	if (!customer || typeof customer !== "object" || !("email" in customer)) return;
	const recipient = customer.email;
	if (typeof recipient !== "string" || !recipient || !emdash.email) return;

	await db
		.insertInto("_emdash_shop_email_outbox")
		.values({ order_id: order.id, status: "pending", attempted_at: null, sent_at: null })
		.onConflict((conflict) => conflict.column("order_id").doNothing())
		.execute();
	const claimed = await db
		.updateTable("_emdash_shop_email_outbox")
		.set({ status: "sending", attempted_at: new Date().toISOString() })
		.where("order_id", "=", order.id)
		.where("status", "=", "pending")
		.executeTakeFirst();
	if (Number(claimed.numUpdatedRows) !== 1) return;

	try {
		const templates = await db
			.selectFrom("_plugin_storage")
			.select("data")
			.where("plugin_id", "=", "email-templates")
			.where("collection", "=", "templates")
			.execute();
		const template = templates
			.map((row) => parseEmailTemplateRecord(row.data))
			.find((record) => record?.slug === "order-confirmation" && record.status === "active");
		if (!template || typeof template.subject !== "string" || typeof template.html !== "string") {
			await db
				.updateTable("_emdash_shop_email_outbox")
				.set({ status: "pending" })
				.where("order_id", "=", order.id)
				.execute();
			return;
		}
		const baseUrl = new URL("/shop/thanks", requestUrl);
		baseUrl.searchParams.set("order", order.orderNumber);
		if (order.trackingToken) baseUrl.searchParams.set("token", order.trackingToken);
		const values: Record<string, string> = {
			order_number: order.orderNumber,
			order_total: `${order.currency} ${order.total.toFixed(2)}`,
			order_url: baseUrl.toString(),
		};
		const render = (source: string) =>
			source.replace(/\{\{(order_number|order_total|order_url)\}\}/g, (_match, key: string) =>
				escapeEmailHtml(values[key] ?? ""),
			);
		const html = render(template.html);
		await emdash.email.send(
			{
				to: recipient,
				subject: render(template.subject),
				text: html
					.replace(/<[^>]*>/g, " ")
					.replace(/\s+/g, " ")
					.trim(),
				html,
			},
			"shop",
		);
		await db
			.updateTable("_emdash_shop_email_outbox")
			.set({ status: "sent", sent_at: new Date().toISOString() })
			.where("order_id", "=", order.id)
			.execute();
	} catch (error) {
		await db
			.updateTable("_emdash_shop_email_outbox")
			.set({ status: "pending" })
			.where("order_id", "=", order.id)
			.execute();
		console.error("[shop-email] order confirmation failed:", error);
	}
}

export const prerender = false;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

export const POST: APIRoute = async ({ request, locals, cookies }) => {
	const dbError = requireDb(locals.emdash?.db);
	if (dbError) return dbError;
	const ip = getClientIp(request, getTrustedProxyHeaders(locals.emdash.config));
	const rateLimit = await checkRateLimit(locals.emdash.db, ip, "shop/orders", 10, 60);
	if (!rateLimit.allowed) return rateLimitResponse(60);
	const idempotencyKey = request.headers.get("Idempotency-Key") ?? "";
	if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
		return apiError("VALIDATION_ERROR", "A valid Idempotency-Key header is required", 400);
	}
	try {
		const body = await parseBody(request, shopOrderCreateBody);
		if (isParseError(body)) return body;
		const result = await handleShopOrderCreate(locals.emdash.db, {
			...body,
			idempotencyKey,
			cartToken: cookies.get("emdash-shop-cart")?.value,
		});
		if (result.success)
			await sendOrderConfirmation(locals.emdash.db, locals.emdash, result.data, request.url);
		return unwrapResult(result, 201);
	} catch (error) {
		return handleError(error, "Failed to create order", "SHOP_ORDER_CREATE_ERROR");
	}
};
