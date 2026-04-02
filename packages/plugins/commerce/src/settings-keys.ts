/**
 * KV keys for admin `settingsSchema` (EmDash stores these under the plugin prefix).
 * Read with `ctx.kv.get("settings:stripeSecretKey")` etc.
 */
export const COMMERCE_SETTINGS_KEYS = {
	stripePublishableKey: "settings:stripePublishableKey",
	stripeSecretKey: "settings:stripeSecretKey",
	stripeWebhookSecret: "settings:stripeWebhookSecret",
	defaultCurrency: "settings:defaultCurrency",
} as const;
