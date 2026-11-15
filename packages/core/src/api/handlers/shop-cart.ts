import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { ContentRepository } from "../../database/repositories/content.js";
import { withTransaction } from "../../database/transaction.js";
import type { Database, ShopCartItemTable, ShopCartTable } from "../../database/types.js";
import type { ApiResult } from "../types.js";

export const CART_COOKIE = "emdash-shop-cart";
const MAX_CART_QUANTITY = 100;
const GUEST_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const PADDING_RE = /=+$/;
type Collection = "products" | "services";
export type ShopCartIdentity = { userId?: string; guestToken?: string };
export type ShopCartView = Pick<ShopCartTable, "id" | "currency" | "locale" | "status"> & {
	items: ShopCartItemTable[];
};
type Result = ApiResult<ShopCartView & { guestToken?: string }>;

const fail = <T>(code: string, message: string): ApiResult<T> => ({
	success: false,
	error: { code, message },
});
const timestamp = () => new Date().toISOString();
const collection = (value?: string): Collection => (value === "services" ? "services" : "products");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

async function hashGuestToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(`shop-cart:${token}`),
	);
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validGuestToken(token?: string): token is string {
	return typeof token === "string" && GUEST_TOKEN_RE.test(token);
}

async function findCart(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
): Promise<ShopCartTable | undefined> {
	if (identity.userId)
		return db
			.selectFrom("_emdash_shop_carts")
			.selectAll()
			.where("user_id", "=", identity.userId)
			.where("status", "=", "active")
			.where("expires_at", ">", timestamp())
			.orderBy("updated_at", "desc")
			.executeTakeFirst();
	if (!validGuestToken(identity.guestToken)) return undefined;
	return db
		.selectFrom("_emdash_shop_carts")
		.selectAll()
		.where("guest_token_hash", "=", await hashGuestToken(identity.guestToken))
		.where("status", "=", "active")
		.where("expires_at", ">", timestamp())
		.executeTakeFirst();
}

async function ensureCart(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
): Promise<{ cart: ShopCartTable; guestToken?: string }> {
	const existing = await findCart(db, identity);
	if (existing) return { cart: existing };
	const guestToken = identity.userId
		? undefined
		: validGuestToken(identity.guestToken)
			? identity.guestToken
			: createGuestToken();
	const created = timestamp();
	const settings = await db
		.selectFrom("_emdash_shop_settings")
		.select("currency")
		.where("id", "=", "default")
		.executeTakeFirst();
	const cart = {
		id: ulid(),
		user_id: identity.userId ?? null,
		guest_token_hash: guestToken ? await hashGuestToken(guestToken) : null,
		status: "active",
		currency: settings?.currency ?? "PEN",
		locale: "en",
		expires_at: new Date(Date.now() + (identity.userId ? 90 : 30) * 86400000).toISOString(),
		converted_order_id: null,
		created_at: created,
		updated_at: created,
		last_accessed_at: created,
	};
	await db.insertInto("_emdash_shop_carts").values(cart).execute();
	return { cart, guestToken };
}

function createGuestToken(): string {
	const bytes = new Uint8Array(32);
	crypto.getRandomValues(bytes);
	return btoa(String.fromCharCode(...bytes))
		.replaceAll("+", "-")
		.replaceAll("/", "_")
		.replace(PADDING_RE, "");
}

async function view(db: Kysely<Database>, cart: ShopCartTable): Promise<ShopCartView> {
	const items = await db
		.selectFrom("_emdash_shop_cart_items")
		.selectAll()
		.where("cart_id", "=", cart.id)
		.orderBy("created_at", "asc")
		.execute();
	return { id: cart.id, currency: cart.currency, locale: cart.locale, status: cart.status, items };
}

async function validateLine(
	db: Kysely<Database>,
	productId: string,
	kind: Collection,
	variantId: string | null | undefined,
	quantity: number,
): Promise<ApiResult<void>> {
	if (!Number.isInteger(quantity) || quantity < 1)
		return fail("SHOP_CART_QUANTITY_INVALID", "Quantity must be a positive integer");
	if (quantity > MAX_CART_QUANTITY)
		return fail("SHOP_CART_QUANTITY_LIMIT", "Cart quantity limit exceeded");
	const item = await new ContentRepository(db).findByIdOrSlug(kind, productId);
	if (!item || item.status !== "published")
		return fail("SHOP_CART_PRODUCT_UNAVAILABLE", "Product is not available");
	const service = item.data.item_type === "service";
	if ((kind === "services") !== service)
		return fail("SHOP_CART_COLLECTION_INVALID", "Collection does not match item type");
	if (!variantId) return { success: true, data: undefined };
	const variants = Array.isArray(item.data.variants) ? item.data.variants : [];
	return variants.some(
		(value) => isRecord(value) && (value.id === variantId || value.label === variantId),
	)
		? { success: true, data: undefined }
		: fail("SHOP_CART_VARIANT_NOT_FOUND", "Product variation not found");
}

export async function handleShopCartGet(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
): Promise<Result> {
	try {
		const ensured = await ensureCart(db, identity);
		await db
			.updateTable("_emdash_shop_carts")
			.set({ last_accessed_at: timestamp() })
			.where("id", "=", ensured.cart.id)
			.execute();
		return {
			success: true,
			data: {
				...(await view(db, ensured.cart)),
				...(ensured.guestToken ? { guestToken: ensured.guestToken } : {}),
			},
		};
	} catch {
		return fail("SHOP_CART_READ_ERROR", "Failed to read cart");
	}
}

export async function handleShopCartItemCreate(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
	input: { productId: string; collection?: string; variantId?: string | null; quantity: number },
): Promise<Result> {
	try {
		const kind = collection(input.collection);
		const check = await validateLine(db, input.productId, kind, input.variantId, input.quantity);
		if (!check.success) return check;
		const ensured = await ensureCart(db, identity);
		await withTransaction(db, async (trx) => {
			const variantId = input.variantId ?? null;
			const existing = await trx
				.selectFrom("_emdash_shop_cart_items")
				.selectAll()
				.where("cart_id", "=", ensured.cart.id)
				.where("collection", "=", kind)
				.where("product_id", "=", input.productId)
				.where("variant_id", variantId === null ? "is" : "=", variantId)
				.executeTakeFirst();
			const quantity = (existing?.quantity ?? 0) + input.quantity;
			if (quantity > MAX_CART_QUANTITY) throw new Error("SHOP_CART_QUANTITY_LIMIT");
			const at = timestamp();
			if (existing)
				await trx
					.updateTable("_emdash_shop_cart_items")
					.set({ quantity, updated_at: at })
					.where("id", "=", existing.id)
					.execute();
			else
				await trx
					.insertInto("_emdash_shop_cart_items")
					.values({
						id: ulid(),
						cart_id: ensured.cart.id,
						collection: kind,
						product_id: input.productId,
						variant_id: variantId,
						quantity,
						created_at: at,
						updated_at: at,
					})
					.execute();
			await trx
				.updateTable("_emdash_shop_carts")
				.set({ updated_at: at, last_accessed_at: at })
				.where("id", "=", ensured.cart.id)
				.execute();
		});
		return {
			success: true,
			data: {
				...(await view(db, ensured.cart)),
				...(ensured.guestToken ? { guestToken: ensured.guestToken } : {}),
			},
		};
	} catch (caught) {
		return caught instanceof Error && caught.message === "SHOP_CART_QUANTITY_LIMIT"
			? fail("SHOP_CART_QUANTITY_LIMIT", "Cart quantity limit exceeded")
			: fail("SHOP_CART_WRITE_ERROR", "Failed to update cart");
	}
}

export async function handleShopCartItemUpdate(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
	itemId: string,
	quantity: number,
): Promise<Result> {
	try {
		const cart = await findCart(db, identity);
		if (!cart) return fail("SHOP_CART_NOT_FOUND", "Cart not found");
		const item = await db
			.selectFrom("_emdash_shop_cart_items")
			.selectAll()
			.where("id", "=", itemId)
			.where("cart_id", "=", cart.id)
			.executeTakeFirst();
		if (!item) return fail("SHOP_CART_ITEM_NOT_FOUND", "Cart item not found");
		const check = await validateLine(
			db,
			item.product_id,
			collection(item.collection),
			item.variant_id,
			quantity,
		);
		if (!check.success) return check;
		await withTransaction(db, async (trx) => {
			const at = timestamp();
			await trx
				.updateTable("_emdash_shop_cart_items")
				.set({ quantity, updated_at: at })
				.where("id", "=", itemId)
				.where("cart_id", "=", cart.id)
				.execute();
			await trx
				.updateTable("_emdash_shop_carts")
				.set({ updated_at: at, last_accessed_at: at })
				.where("id", "=", cart.id)
				.execute();
		});
		return { success: true, data: await view(db, cart) };
	} catch {
		return fail("SHOP_CART_WRITE_ERROR", "Failed to update cart");
	}
}

export async function handleShopCartItemDelete(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
	itemId: string,
): Promise<Result> {
	try {
		const cart = await findCart(db, identity);
		if (!cart) return fail("SHOP_CART_NOT_FOUND", "Cart not found");
		await withTransaction(db, async (trx) => {
			const at = timestamp();
			await trx
				.deleteFrom("_emdash_shop_cart_items")
				.where("id", "=", itemId)
				.where("cart_id", "=", cart.id)
				.execute();
			await trx
				.updateTable("_emdash_shop_carts")
				.set({ updated_at: at, last_accessed_at: at })
				.where("id", "=", cart.id)
				.execute();
		});
		return { success: true, data: await view(db, cart) };
	} catch {
		return fail("SHOP_CART_WRITE_ERROR", "Failed to update cart");
	}
}

export async function handleShopCartClear(
	db: Kysely<Database>,
	identity: ShopCartIdentity,
): Promise<Result> {
	try {
		const cart = await findCart(db, identity);
		if (!cart) return fail("SHOP_CART_NOT_FOUND", "Cart not found");
		await withTransaction(db, async (trx) => {
			const at = timestamp();
			await trx.deleteFrom("_emdash_shop_cart_items").where("cart_id", "=", cart.id).execute();
			await trx
				.updateTable("_emdash_shop_carts")
				.set({ updated_at: at, last_accessed_at: at })
				.where("id", "=", cart.id)
				.execute();
		});
		return { success: true, data: await view(db, cart) };
	} catch {
		return fail("SHOP_CART_WRITE_ERROR", "Failed to update cart");
	}
}

export async function handleShopCartMerge(
	db: Kysely<Database>,
	userId: string,
	guestToken?: string,
): Promise<Result> {
	try {
		if (!userId) return fail("SHOP_CART_AUTH_REQUIRED", "Authenticated user is required");
		const guest = guestToken ? await findCart(db, { guestToken }) : undefined;
		const userCart = await ensureCart(db, { userId });
		if (!guest || guest.id === userCart.cart.id)
			return { success: true, data: await view(db, userCart.cart) };
		await withTransaction(db, async (trx) => {
			const guestItems = await trx
				.selectFrom("_emdash_shop_cart_items")
				.selectAll()
				.where("cart_id", "=", guest.id)
				.execute();
			for (const item of guestItems) {
				const existing = await trx
					.selectFrom("_emdash_shop_cart_items")
					.selectAll()
					.where("cart_id", "=", userCart.cart.id)
					.where("collection", "=", item.collection)
					.where("product_id", "=", item.product_id)
					.where("variant_id", item.variant_id === null ? "is" : "=", item.variant_id)
					.executeTakeFirst();
				const quantity = Math.min(MAX_CART_QUANTITY, (existing?.quantity ?? 0) + item.quantity);
				if (existing)
					await trx
						.updateTable("_emdash_shop_cart_items")
						.set({ quantity, updated_at: timestamp() })
						.where("id", "=", existing.id)
						.execute();
				else
					await trx
						.updateTable("_emdash_shop_cart_items")
						.set({ cart_id: userCart.cart.id, updated_at: timestamp() })
						.where("id", "=", item.id)
						.execute();
			}
			await trx
				.updateTable("_emdash_shop_carts")
				.set({ status: "merged", updated_at: timestamp(), last_accessed_at: timestamp() })
				.where("id", "=", guest.id)
				.execute();
		});
		return { success: true, data: await view(db, userCart.cart) };
	} catch {
		return fail("SHOP_CART_MERGE_ERROR", "Failed to merge carts");
	}
}
