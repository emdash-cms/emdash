import type { EmailBrandingValues } from "./email-branding.js";
import { emailButtonColorStyle, emailButtonSizeStyle } from "./email-branding.js";

const EMAIL_FOOTER_CUSTOM_STYLE = "--emdash-email-footer-custom:1;";
const EMAIL_FOOTER_BACKGROUND_RE = /background-color:\s*([^;]+)/i;

export type EmailTemplatePresetId =
	| "order-confirmation"
	| "payment-confirmation"
	| "order-shipped"
	| "order-delivered";

export interface EmailTemplatePreset {
	id: EmailTemplatePresetId;
	slug: string;
	name: string;
	subject: string;
	buildContent: (branding: EmailBrandingValues) => Record<string, unknown>;
	buildHtml: (branding: EmailBrandingValues) => string;
}

function paragraph(text: string): Record<string, unknown> {
	return { type: "paragraph", content: [{ type: "text", text }] };
}

function heading(text: string): Record<string, unknown> {
	return {
		type: "heading",
		attrs: {
			level: 1,
			align: "center",
			alignment: "center",
			style: "text-align:center;margin:0 0 24px;",
		},
		content: [{ type: "text", text }],
	};
}

function header(branding: EmailBrandingValues): Record<string, unknown> {
	return {
		type: "section",
		attrs: {
			style: `--emdash-email-header:1;background-color:${branding.background};width:100%;max-width:600px;box-sizing:border-box;margin:0 auto 32px;padding:24px;text-align:center;`,
		},
		content: [
			branding.logoUrl
				? {
						type: "image",
						attrs: {
							src: branding.logoUrl,
							alt: branding.logoAlt || branding.siteName,
							alignment: "center",
							style:
								"display:block;margin-left:auto;margin-right:auto;max-width:160px;max-height:48px;",
						},
					}
				: {
						type: "heading",
						attrs: { level: 2, align: "center", alignment: "center" },
						content: [{ type: "text", text: branding.siteName || "Logo" }],
					},
		],
	};
}

function footer(branding: EmailBrandingValues): Record<string, unknown> {
	return {
		type: "section",
		attrs: {
			style: `--emdash-email-footer:1;background-color:${branding.background};color:${branding.text};width:100%;max-width:600px;box-sizing:border-box;min-height:0;height:auto;margin:32px auto 0;padding:10px 24px 8px;text-align:center;border-top:1px solid #d1d5db;`,
		},
		content: [
			{
				type: "paragraph",
				attrs: {
					align: "center",
					alignment: "center",
					style: "text-align:center;font-size:12px;line-height:1.2;margin:0;padding:0;",
				},
				content: [
					{
						type: "text",
						text: `© ${branding.siteName || "EmDash"}. Todos los derechos reservados.`,
					},
				],
			},
			{
				type: "paragraph",
				attrs: {
					align: "center",
					alignment: "center",
					style:
						"text-align:center;font-size:11px;line-height:1.2;color:#6b7280;margin:4px 0 0;padding:0;",
				},
				content: [
					{
						type: "text",
						text: "Desuscribirse",
						marks: [
							{
								type: "link",
								attrs: {
									href: "{{unsubscribe_url}}",
									target: "_blank",
									rel: "noopener noreferrer",
								},
							},
						],
					},
				],
			},
		],
	};
}

function button(
	branding: EmailBrandingValues,
	text: string,
	href: string,
): Record<string, unknown> {
	return {
		type: "button",
		attrs: {
			href,
			alignment: "center",
			style: `${emailButtonColorStyle(branding)}${emailButtonSizeStyle()}display:inline-block;margin-top:20px;border-radius:6px;font-weight:600;text-decoration:none;`,
		},
		content: [{ type: "text", text }],
	};
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>'"]/g, (character) => {
		const entities: Record<string, string> = {
			"&": "&amp;",
			"<": "&lt;",
			">": "&gt;",
			"'": "&#39;",
			'"': "&quot;",
		};
		return entities[character] ?? character;
	});
}

function htmlDocument(
	branding: EmailBrandingValues,
	content: { heading: string; paragraphs: string[]; buttonText: string; buttonHref: string },
): string {
	const paragraphs = content.paragraphs
		.map((text) => `<p style="color:${branding.text};">${escapeHtml(text)}</p>`)
		.join("");
	const siteName = branding.siteName || "EmDash";
	const headerContent = branding.logoUrl
		? `<img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.logoAlt || branding.siteName)}" style="display:block;margin-left:auto;margin-right:auto;max-width:160px;max-height:48px;">`
		: `<h2 style="margin:0;">${escapeHtml(branding.siteName || "Logo")}</h2>`;
	return `<html><body style="background-color:${branding.background};color:${branding.text};font-family:${branding.font};"><section style="--emdash-email-header:1;background-color:${branding.background};width:100%;max-width:600px;box-sizing:border-box;margin:0 auto 32px;padding:24px;text-align:center;">${headerContent}</section><main style="background-color:${branding.surface};padding:32px 24px 40px;"><h1 style="margin:0 0 24px;">${escapeHtml(content.heading)}</h1>${paragraphs}<p style="text-align:center;margin:20px 0 0;"><a class="node-button" href="${escapeHtml(content.buttonHref)}" style="${emailButtonColorStyle(branding)}${emailButtonSizeStyle()}border-radius:6px;font-weight:600;text-decoration:none;">${escapeHtml(content.buttonText)}</a></p></main><footer style="--emdash-email-footer:1;background-color:${branding.background};color:${branding.text};width:100%;max-width:600px;box-sizing:border-box;min-height:0;height:auto;margin:32px auto 0;padding:10px 24px 8px;text-align:center;border-top:1px solid #d1d5db;"><p style="text-align:center;font-size:12px;line-height:1.2;margin:0;">© ${escapeHtml(siteName)}. Todos los derechos reservados.</p><p style="text-align:center;font-size:11px;line-height:1.2;color:#6b7280;margin:4px 0 0;"><a href="{{unsubscribe_url}}" target="_blank" rel="noopener noreferrer">Desuscribirse</a></p></footer></body></html>`;
}

export function applyEmailBrandingToEditorContent(
	content: unknown,
	branding: EmailBrandingValues,
): unknown {
	if (Array.isArray(content))
		return content.map((node) => applyEmailBrandingToEditorContent(node, branding));
	if (!content || typeof content !== "object") return content;
	const node = content as Record<string, unknown>;
	const style = (node.attrs as Record<string, unknown> | undefined)?.style;
	if (typeof style === "string" && style.includes("--emdash-email-header:1"))
		return header(branding);
	if (typeof style === "string" && style.includes("--emdash-email-footer:1")) {
		const nextFooter = footer(branding);
		if (style.includes(EMAIL_FOOTER_CUSTOM_STYLE)) {
			const background = style.match(EMAIL_FOOTER_BACKGROUND_RE)?.[1]?.trim();
			if (background) {
				const attrs = nextFooter.attrs as Record<string, unknown>;
				return {
					...nextFooter,
					attrs: {
						...attrs,
						style: String(attrs.style).replace(
							EMAIL_FOOTER_BACKGROUND_RE,
							`background-color:${background}`,
						),
					},
				};
			}
		}
		return nextFooter;
	}
	if (!Array.isArray(node.content)) return content;
	return {
		...node,
		content: node.content.map((child) => applyEmailBrandingToEditorContent(child, branding)),
	};
}

function document(
	branding: EmailBrandingValues,
	content: Record<string, unknown>[],
): Record<string, unknown> {
	return {
		type: "doc",
		content: [{ type: "section", content: [header(branding), ...content, footer(branding)] }],
	};
}

export const DEFAULT_EMAIL_TEMPLATE_PRESETS: readonly EmailTemplatePreset[] = [
	{
		id: "order-confirmation",
		slug: "order-confirmation",
		name: "Confirmación de pedido",
		subject: "Confirmación de pedido {{order_number}}",
		buildContent: (branding) =>
			document(branding, [
				heading("¡Gracias por tu pedido!"),
				paragraph("Hola {{customer_name}}, hemos recibido tu pedido y estamos preparándolo."),
				paragraph("Número de pedido: {{order_number}}"),
				paragraph("Total: {{order_total}}"),
				button(branding, "Ver tu pedido", "{{order_url}}"),
			]),
		buildHtml: (branding) =>
			htmlDocument(branding, {
				heading: "¡Gracias por tu pedido!",
				paragraphs: [
					"Hola {{customer_name}}, hemos recibido tu pedido y estamos preparándolo.",
					"Número de pedido: {{order_number}}",
					"Total: {{order_total}}",
				],
				buttonText: "Ver tu pedido",
				buttonHref: "{{order_url}}",
			}),
	},
	{
		id: "payment-confirmation",
		slug: "payment-confirmation",
		name: "Confirmación de pago",
		subject: "Pago confirmado para {{order_number}}",
		buildContent: (branding) =>
			document(branding, [
				heading("Pago confirmado"),
				paragraph("Hola {{customer_name}}, tu pago se procesó correctamente."),
				paragraph("Número de pedido: {{order_number}}"),
				paragraph("Importe pagado: {{order_total}}"),
				button(branding, "Ver comprobante", "{{receipt_url}}"),
			]),
		buildHtml: (branding) =>
			htmlDocument(branding, {
				heading: "Pago confirmado",
				paragraphs: [
					"Hola {{customer_name}}, tu pago se procesó correctamente.",
					"Número de pedido: {{order_number}}",
					"Importe pagado: {{order_total}}",
				],
				buttonText: "Ver comprobante",
				buttonHref: "{{receipt_url}}",
			}),
	},
	{
		id: "order-shipped",
		slug: "order-shipped",
		name: "Pedido enviado",
		subject: "Tu pedido {{order_number}} está en camino",
		buildContent: (branding) =>
			document(branding, [
				heading("Tu pedido está en camino"),
				paragraph("Hola {{customer_name}}, tu pedido ha sido enviado y está en camino."),
				paragraph("Número de pedido: {{order_number}}"),
				paragraph("Número de seguimiento: {{tracking_number}}"),
				button(branding, "Rastrear pedido", "{{tracking_url}}"),
			]),
		buildHtml: (branding) =>
			htmlDocument(branding, {
				heading: "Tu pedido está en camino",
				paragraphs: [
					"Hola {{customer_name}}, tu pedido ha sido enviado y está en camino.",
					"Número de pedido: {{order_number}}",
					"Número de seguimiento: {{tracking_number}}",
				],
				buttonText: "Rastrear pedido",
				buttonHref: "{{tracking_url}}",
			}),
	},
	{
		id: "order-delivered",
		slug: "order-delivered",
		name: "Pedido entregado",
		subject: "Tu pedido {{order_number}} fue entregado",
		buildContent: (branding) =>
			document(branding, [
				heading("Tu pedido fue entregado"),
				paragraph("Hola {{customer_name}}, tu pedido fue entregado. ¡Esperamos que lo disfrutes!"),
				paragraph("Número de pedido: {{order_number}}"),
				button(branding, "Ver tu pedido", "{{order_url}}"),
			]),
		buildHtml: (branding) =>
			htmlDocument(branding, {
				heading: "Tu pedido fue entregado",
				paragraphs: [
					"Hola {{customer_name}}, tu pedido fue entregado. ¡Esperamos que lo disfrutes!",
					"Número de pedido: {{order_number}}",
				],
				buttonText: "Ver tu pedido",
				buttonHref: "{{order_url}}",
			}),
	},
];

export function getEmailTemplatePreset(id: EmailTemplatePresetId): EmailTemplatePreset {
	return (
		DEFAULT_EMAIL_TEMPLATE_PRESETS.find((preset) => preset.id === id) ??
		DEFAULT_EMAIL_TEMPLATE_PRESETS[0]!
	);
}
