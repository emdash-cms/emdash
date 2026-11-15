export interface EmailBrandingSettings {
	title?: string;
	logo?: { alt?: string; url?: string };
	theme?: {
		colors?: {
			primary?: string;
			background?: string;
			surface?: string;
			text?: string;
			onPrimary?: string;
		};
		fonts?: { body?: string };
	};
}

export interface EmailBrandingValues {
	logoUrl?: string;
	logoAlt: string;
	siteName: string;
	primary: string;
	background: string;
	surface: string;
	text: string;
	onPrimary: string;
	font: string;
}

export type EmailButtonSize = "sm" | "medium" | "large";

export const DEFAULT_EMAIL_BRANDING: EmailBrandingValues = {
	logoAlt: "",
	siteName: "",
	primary: "#000000",
	background: "#f4f4f5",
	surface: "#ffffff",
	text: "#18181b",
	onPrimary: "#ffffff",
	font: "Arial, Helvetica, sans-serif",
};

const BRANDING_HEADER_RE = /<div data-emdash-email-branding="true"[^>]*>[\s\S]*?<\/div>/i;
const BODY_TAG_RE = /<body\b[^>]*>/i;
const STYLE_ATTRIBUTE_RE = /\bstyle="([^"]*)"/i;
const STYLE_ATTRIBUTE_ANY_RE = /\bstyle="[^"]*"/i;
const BRANDING_STYLE_PROPERTIES_RE = /(?:background-color|color|font-family):[^;]*;?/gi;
const EMAIL_ANCHOR_TAG_RE = /<a\b[^>]*>/gi;
const EMAIL_BUTTON_CLASS_RE = /\bclass="[^"]*\bnode-button\b[^"]*"/i;
const EMAIL_BUTTON_STYLE_PROPERTIES_RE = /(?:background-color|color):[^;]*;?/gi;
const EMAIL_FOOTER_BLOCK_RE =
	/(<(footer|section|div|table)\b(?=[^>]*--emdash-email-footer:1)[^>]*>)([\s\S]*?)(<\/\2>)/gi;
const EMAIL_STYLE_ATTRIBUTE_RE = /\bstyle="([^"]*)"/i;
const EMAIL_PARAGRAPH_TAG_RE = /<p\b[^>]*>/gi;
const TAG_END_RE = />$/;

export function emailButtonColorStyle(branding: EmailBrandingValues): string {
	return `background-color:${branding.primary};color:${branding.onPrimary};`;
}

export function emailButtonSizeStyle(size: EmailButtonSize = "medium"): string {
	const styles: Record<EmailButtonSize, string> = {
		sm: "padding:8px 16px;font-size:14px;",
		medium: "padding:12px 24px;font-size:16px;",
		large: "padding:16px 32px;font-size:18px;",
	};
	return styles[size];
}

export function resolveEmailBranding(settings?: EmailBrandingSettings): EmailBrandingValues {
	const colors = settings?.theme?.colors;
	return {
		logoUrl: settings?.logo?.url,
		logoAlt: settings?.logo?.alt || settings?.title || "",
		siteName: settings?.title || "",
		primary: colors?.primary ?? DEFAULT_EMAIL_BRANDING.primary,
		background: colors?.background ?? DEFAULT_EMAIL_BRANDING.background,
		surface: colors?.surface ?? DEFAULT_EMAIL_BRANDING.surface,
		text: colors?.text ?? DEFAULT_EMAIL_BRANDING.text,
		onPrimary: colors?.onPrimary ?? DEFAULT_EMAIL_BRANDING.onPrimary,
		font: settings?.theme?.fonts?.body ?? DEFAULT_EMAIL_BRANDING.font,
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

function setInlineStyleProperty(style: string, property: string, value: string): string {
	const normalizedStyle =
		property === "margin"
			? style.replace(/margin-(?:top|right|bottom|left)\s*:[^;]*;?/gi, "")
			: property === "padding"
				? style.replace(/padding-(?:top|right|bottom|left)\s*:[^;]*;?/gi, "")
				: style;
	const propertyPattern = new RegExp(`(^|;)${property}\\s*:[^;]*;?`, "i");
	const declaration = `${property}:${value};`;
	return propertyPattern.test(normalizedStyle)
		? normalizedStyle.replace(
				propertyPattern,
				(_match, prefix: string) => `${prefix}${declaration}`,
			)
		: `${normalizedStyle}${normalizedStyle && !normalizedStyle.endsWith(";") ? ";" : ""}${declaration}`;
}

function normalizeEmailFooterLayout(html: string): string {
	return html.replace(
		EMAIL_FOOTER_BLOCK_RE,
		(block, openingTag: string, _tagName: string, body: string, closingTag: string) => {
			const compactOpeningTag = openingTag.replace(
				EMAIL_STYLE_ATTRIBUTE_RE,
				(_match, style: string) => {
					const compactStyle = setInlineStyleProperty(
						setInlineStyleProperty(style, "margin", "32px auto 0"),
						"padding",
						"10px 24px 8px",
					);
					const withAutomaticHeight = setInlineStyleProperty(
						setInlineStyleProperty(compactStyle, "min-height", "0"),
						"height",
						"auto",
					);
					return `style="${escapeHtml(withAutomaticHeight)}"`;
				},
			);
			let paragraphIndex = 0;
			const compactBody = body.replace(EMAIL_PARAGRAPH_TAG_RE, (paragraphTag) => {
				const margin = paragraphIndex++ === 0 ? "0" : "4px 0 0";
				if (!EMAIL_STYLE_ATTRIBUTE_RE.test(paragraphTag)) {
					return paragraphTag.replace(TAG_END_RE, ` style="margin:${margin};padding:0;">`);
				}
				return paragraphTag.replace(EMAIL_STYLE_ATTRIBUTE_RE, (_match, style: string) => {
					const compactStyle = setInlineStyleProperty(
						setInlineStyleProperty(style, "margin", margin),
						"padding",
						"0",
					);
					return `style="${escapeHtml(compactStyle)}"`;
				});
			});
			return `${compactOpeningTag}${compactBody}${closingTag}`;
		},
	);
}

/** Applies current site colors and typography to generated email HTML. */
export function applyEmailBranding(html: string, branding: EmailBrandingValues): string {
	const withoutPreviousHeader = html.replace(BRANDING_HEADER_RE, "");
	if (!BODY_TAG_RE.test(withoutPreviousHeader))
		return normalizeEmailFooterLayout(withoutPreviousHeader);
	const brandedHtml = withoutPreviousHeader.replace(BODY_TAG_RE, (tag) => {
		const existingStyle = (tag.match(STYLE_ATTRIBUTE_RE)?.[1] ?? "").replace(
			BRANDING_STYLE_PROPERTIES_RE,
			"",
		);
		const style = `${existingStyle}${existingStyle && !existingStyle.endsWith(";") ? ";" : ""}background-color:${branding.background};color:${branding.text};font-family:${branding.font};`;
		const styledTag = STYLE_ATTRIBUTE_ANY_RE.test(tag)
			? tag.replace(STYLE_ATTRIBUTE_ANY_RE, `style="${escapeHtml(style)}"`)
			: tag.replace(TAG_END_RE, ` style="${escapeHtml(style)}">`);
		return styledTag;
	});
	const brandedButtons = brandedHtml.replace(EMAIL_ANCHOR_TAG_RE, (tag) => {
		if (!EMAIL_BUTTON_CLASS_RE.test(tag)) return tag;
		const existingStyle = (tag.match(STYLE_ATTRIBUTE_RE)?.[1] ?? "").replace(
			EMAIL_BUTTON_STYLE_PROPERTIES_RE,
			"",
		);
		const style = `${existingStyle}${existingStyle && !existingStyle.endsWith(";") ? ";" : ""}${emailButtonColorStyle(branding)}`;
		return STYLE_ATTRIBUTE_ANY_RE.test(tag)
			? tag.replace(STYLE_ATTRIBUTE_ANY_RE, `style="${escapeHtml(style)}"`)
			: tag.replace(TAG_END_RE, ` style="${escapeHtml(style)}">`);
	});
	return normalizeEmailFooterLayout(brandedButtons);
}
