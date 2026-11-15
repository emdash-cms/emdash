export type EmailBlockType =
	| "section"
	| "columns"
	| "branding"
	| "footer"
	| "text"
	| "heading"
	| "image"
	| "button"
	| "divider"
	| "spacer"
	| "social"
	| "html";

export type EmailBlockCategory = "layout" | "content" | "media" | "actions" | "advanced";

export interface EmailBlockDefinition {
	type: EmailBlockType;
	label: string;
	category: EmailBlockCategory;
	defaultProps: Record<string, unknown>;
	container?: boolean;
}

export interface EmailFontDefinition {
	id: string;
	label: string;
	fontFamily: string;
	category: "sans" | "serif" | "mono";
}

export interface EmailEditorTheme {
	backgroundColor: string;
	contentBackgroundColor: string;
	textColor: string;
	accentColor: string;
	fontFamily: string;
}

export interface EmailLayoutNode {
	type: "section" | "columns" | "column" | EmailBlockType;
	props?: Record<string, unknown>;
	children?: EmailLayoutNode[];
}

export interface EmailEditorConfig {
	blocks: readonly EmailBlockDefinition[];
	fonts: readonly EmailFontDefinition[];
	theme: EmailEditorTheme;
	defaultLayout: EmailLayoutNode;
}

export const EMAIL_SAFE_FONTS: readonly EmailFontDefinition[] = [
	{ id: "arial", label: "Arial", fontFamily: "Arial, Helvetica, sans-serif", category: "sans" },
	{
		id: "helvetica",
		label: "Helvetica",
		fontFamily: "Helvetica, Arial, sans-serif",
		category: "sans",
	},
	{ id: "verdana", label: "Verdana", fontFamily: "Verdana, Arial, sans-serif", category: "sans" },
	{ id: "tahoma", label: "Tahoma", fontFamily: "Tahoma, Arial, sans-serif", category: "sans" },
	{
		id: "trebuchet-ms",
		label: "Trebuchet MS",
		fontFamily: "'Trebuchet MS', Arial, sans-serif",
		category: "sans",
	},
	{
		id: "georgia",
		label: "Georgia",
		fontFamily: "Georgia, 'Times New Roman', serif",
		category: "serif",
	},
	{
		id: "times-new-roman",
		label: "Times New Roman",
		fontFamily: "'Times New Roman', Times, serif",
		category: "serif",
	},
	{
		id: "courier-new",
		label: "Courier New",
		fontFamily: "'Courier New', monospace",
		category: "mono",
	},
];

export const DEFAULT_EMAIL_BLOCKS: readonly EmailBlockDefinition[] = [
	{
		type: "branding",
		label: "Email header",
		category: "layout",
		defaultProps: {},
	},
	{
		type: "footer",
		label: "Email footer",
		category: "layout",
		defaultProps: {},
	},
	{
		type: "text",
		label: "Text",
		category: "content",
		defaultProps: { text: "Write your message" },
	},
	{
		type: "heading",
		label: "Heading",
		category: "content",
		defaultProps: { level: 1, text: "Heading" },
	},
	{ type: "image", label: "Image", category: "media", defaultProps: { mediaId: null, alt: "" } },
	{
		type: "button",
		label: "Button",
		category: "actions",
		defaultProps: {
			text: "Call to action",
			href: "https://example.com",
			alignment: "center",
			size: "medium",
			style:
				"background-color: #000000; color: #ffffff; padding: 12px 24px; border-radius: 6px; font-size: 16px; font-weight: 600; text-decoration: none;",
		},
	},
	{ type: "divider", label: "Divider", category: "content", defaultProps: {} },
	{ type: "spacer", label: "Spacer", category: "layout", defaultProps: { height: 24 } },
	{ type: "social", label: "Social links", category: "actions", defaultProps: { links: [] } },
	{ type: "html", label: "Custom HTML", category: "advanced", defaultProps: { html: "" } },
];

export const DEFAULT_EMAIL_EDITOR_CONFIG: EmailEditorConfig = {
	blocks: DEFAULT_EMAIL_BLOCKS,
	fonts: EMAIL_SAFE_FONTS,
	theme: {
		backgroundColor: "#f4f4f5",
		contentBackgroundColor: "#ffffff",
		textColor: "#18181b",
		accentColor: "#2563eb",
		fontFamily: EMAIL_SAFE_FONTS[0]?.fontFamily ?? "Arial, Helvetica, sans-serif",
	},
	defaultLayout: {
		type: "section",
		children: [
			{
				type: "columns",
				props: { count: 1 },
				children: [
					{ type: "column", children: [{ type: "heading", props: { level: 1, text: "Welcome" } }] },
				],
			},
		],
	},
};

const BODY_WITH_STYLE_RE = /(<body\b[^>]*\bstyle=")([^"]*)("[^>]*>)/i;
const BODY_TAG_RE = /<body\b/i;
const DIVIDER_STYLE_RE = /(<hr\b[^>]*\bstyle=")([^"]*)(")/gi;
const DIVIDER_PADDING_RE = /padding-bottom:\s*1em;?/i;

/** Adds the selected system-font stack to the exported email document. */
export function applyEmailSafeFont(
	html: string,
	fontFamily = DEFAULT_EMAIL_EDITOR_CONFIG.theme.fontFamily,
): string {
	const safeFont = EMAIL_SAFE_FONTS.some((font) => font.fontFamily === fontFamily)
		? fontFamily
		: DEFAULT_EMAIL_EDITOR_CONFIG.theme.fontFamily;
	const declaration = `font-family: ${safeFont};`;
	const normalizedHtml = html.replace(
		DIVIDER_STYLE_RE,
		(_match, prefix: string, style: string, suffix: string) => {
			const compactStyle = style.replace(DIVIDER_PADDING_RE, "padding-bottom:0;");
			const safeStyle = compactStyle.endsWith(";") ? compactStyle : `${compactStyle};`;
			return `${prefix}${safeStyle}margin-top:1em;margin-bottom:1em;${suffix}`;
		},
	);
	if (BODY_WITH_STYLE_RE.test(normalizedHtml)) {
		return normalizedHtml.replace(BODY_WITH_STYLE_RE, `$1$2 ${declaration}$3`);
	}
	return normalizedHtml.replace(BODY_TAG_RE, `<body style="${declaration}"`);
}
