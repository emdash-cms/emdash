import { describe, expect, it } from "vitest";

import { resolveEmailBranding } from "../src/email-branding.js";
import {
	applyEmailBrandingToEditorContent,
	DEFAULT_EMAIL_TEMPLATE_PRESETS,
} from "../src/presets.js";

function flattenNodes(value: unknown): Record<string, unknown>[] {
	if (!value || typeof value !== "object") return [];
	if (Array.isArray(value)) return value.flatMap(flattenNodes);
	const node = value as Record<string, unknown>;
	return [node, ...flattenNodes(node.content)];
}

describe("email template presets", () => {
	it("provides ecommerce presets with header, footer, and branded button blocks", () => {
		const branding = resolveEmailBranding({ title: "Acme" });

		expect(DEFAULT_EMAIL_TEMPLATE_PRESETS).toHaveLength(4);
		for (const preset of DEFAULT_EMAIL_TEMPLATE_PRESETS) {
			const nodes = flattenNodes(preset.buildContent(branding));
			const html = preset.buildHtml(branding);

			expect(
				nodes.some((node) =>
					String((node.attrs as { style?: string } | undefined)?.style).includes(
						"--emdash-email-header:1",
					),
				),
			).toBe(true);
			expect(
				nodes.some((node) =>
					String((node.attrs as { style?: string } | undefined)?.style).includes(
						"--emdash-email-footer:1",
					),
				),
			).toBe(true);
			expect(
				nodes.some((node) => {
					const style = (node.attrs as { style?: string } | undefined)?.style;
					return (
						node.type === "button" &&
						style?.includes("#000000") === true &&
						style.includes("margin-top:20px")
					);
				}),
			).toBe(true);
			expect(html).toContain('class="node-button"');
			expect(html).toContain("{{order_number}}");
		}
	});

	it("uses the configured logo in the header and keeps the footer centered", () => {
		const branding = resolveEmailBranding({
			title: "Acme",
			logo: { alt: "Acme logo", url: "/media/acme.svg" },
		});
		const preset = DEFAULT_EMAIL_TEMPLATE_PRESETS[0]!;
		const document = preset.buildContent(branding) as {
			content: Array<{ content?: Array<Record<string, unknown>> }>;
		};
		const blocks = document.content[0]?.content ?? [];
		const images = flattenNodes(document).filter((node) => node.type === "image");
		const footer = blocks.find((node) =>
			String((node.attrs as { style?: string } | undefined)?.style).includes(
				"--emdash-email-footer:1",
			),
		);
		const footerContent = footer?.content as Array<Record<string, unknown>> | undefined;
		const html = preset.buildHtml(branding);

		expect(images).toHaveLength(1);
		expect(images[0]?.attrs).toMatchObject({ src: "/media/acme.svg", alignment: "center" });
		expect(footerContent?.[0]?.type).toBe("paragraph");
		expect((footerContent?.[0]?.attrs as { alignment?: string } | undefined)?.alignment).toBe(
			"center",
		);
		expect(html.match(/<img /g)).toHaveLength(1);
		expect(html).not.toContain("<table");
		expect(html).toContain("text-align:center;font-size:12px;line-height:1.2;margin:0;");
		expect(html).toContain("margin:0 auto 32px");
		expect(html).toContain("margin:32px auto 0");
		expect(html).toContain("padding:10px 24px 8px");
		expect(html).toContain("margin:20px 0 0");
		expect(html).toContain("margin:4px 0 0");
		expect(html).toContain('<h1 style="margin:0 0 24px;">');
		expect(html).toContain('href="{{unsubscribe_url}}"');
		expect(
			String((blocks.find((node) => node.type === "heading")?.attrs as { style?: string })?.style),
		).toContain("margin:0 0 24px");
	});

	it("refreshes branded blocks when the email settings change", () => {
		const previousBranding = resolveEmailBranding({
			title: "Tienda anterior",
			logo: { url: "/media/old.svg" },
		});
		const currentBranding = resolveEmailBranding({
			title: "Tienda nueva",
			logo: { url: "/media/new.svg" },
		});
		const previousContent = DEFAULT_EMAIL_TEMPLATE_PRESETS[0]!.buildContent(previousBranding);
		const refreshedContent = applyEmailBrandingToEditorContent(previousContent, currentBranding);
		const nodes = flattenNodes(refreshedContent);

		const images = nodes.filter((node) => node.type === "image");
		expect(images).toHaveLength(1);
		expect(images.find((node) => node.attrs)?.attrs).toMatchObject({
			src: "/media/new.svg",
		});
		expect(
			nodes.some((node) => node.text === "© Tienda nueva. Todos los derechos reservados."),
		).toBe(true);
	});

	it("preserves a custom footer background when branding is refreshed", () => {
		const branding = resolveEmailBranding({ title: "Tienda" });
		const content = DEFAULT_EMAIL_TEMPLATE_PRESETS[0]!.buildContent(branding) as {
			content: Array<{ content?: Array<Record<string, unknown>> }>;
		};
		const blocks = content.content[0]?.content ?? [];
		const footer = blocks.find((node) =>
			String((node.attrs as { style?: string } | undefined)?.style).includes(
				"--emdash-email-footer:1",
			),
		);
		const attrs = footer?.attrs as { style: string };
		attrs.style =
			"--emdash-email-footer-custom:1;" +
			attrs.style.replace("background-color:#f4f4f5", "background-color:#123456");

		const refreshed = applyEmailBrandingToEditorContent(content, branding);
		const refreshedFooter = flattenNodes(refreshed).find((node) =>
			String((node.attrs as { style?: string } | undefined)?.style).includes(
				"--emdash-email-footer:1",
			),
		);

		expect((refreshedFooter?.attrs as { style?: string } | undefined)?.style).toContain(
			"background-color:#123456",
		);
	});

	it("creates the default order template in Spanish", () => {
		const branding = resolveEmailBranding({ title: "Acme" });
		const preset = DEFAULT_EMAIL_TEMPLATE_PRESETS[0]!;
		const text = flattenNodes(preset.buildContent(branding))
			.map((node) => node.text)
			.filter((value): value is string => Boolean(value))
			.join(" ");

		expect(preset.name).toBe("Confirmación de pedido");
		expect(text).toContain("¡Gracias por tu pedido!");
		expect(text).toContain("Ver tu pedido");
		expect(preset.buildHtml(branding)).toContain("Desuscribirse");
	});
});
