import { z } from "zod";

const cartLine = z.object({
	productId: z.string().min(1).max(200),
	collection: z.enum(["products", "services"]).optional(),
	variantId: z.string().min(1).max(200).nullable().optional(),
	quantity: z.number().int().min(1).max(100),
});

export const shopCartItemCreateBody = cartLine.meta({ id: "ShopCartItemCreateBody" });
export const shopCartItemUpdateBody = z
	.object({ quantity: z.number().int().min(1).max(100) })
	.meta({ id: "ShopCartItemUpdateBody" });
