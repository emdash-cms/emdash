/**
 * renderBlockDocument — convert a BuilderDocument to an HTML string.
 *
 * This renderer is independent of Lexical. It reads BuilderDocument
 * (the source of truth) and outputs HTML for public rendering.
 *
 * It does NOT use Lexical to render.
 */
import type {
	BuilderBlock,
	BuilderColumnsBlock,
	BuilderDocument,
	BuilderRichTextBlock,
	BuilderSectionBlock,
} from "./schema.js";

// ── Portable Text → HTML ─────────────────────────────────────────────────────

function renderPortableText(content: BuilderRichTextBlock["content"]): string {
	if (!content || content.length === 0) return "";

	return content
		.map((node) => {
			if (node._type === "paragraph") {
				const text = node.children
					?.map((child) => {
						let t = escapeHtml(child.text ?? "");
						if (child.bold) t = `<strong>${t}</strong>`;
						if (child.italic) t = `<em>${t}</em>`;
						if (child.underline) t = `<u>${t}</u>`;
						if (child.strikethrough) t = `<s>${t}</s>`;
						if (child.code) t = `<code>${t}</code>`;
						return t;
					})
					.join("");
				return `<p>${text ?? ""}</p>`;
			}
			if (node._type === "heading") {
				const level = (node as { level?: number }).level ?? 2;
				const text = node.children?.map((c) => escapeHtml(c.text ?? "")).join("") ?? "";
				return `<h${level}>${text}</h${level}>`;
			}
			if (node._type === "span") {
				let t = escapeHtml(node.text ?? "");
				if (node.bold) t = `<strong>${t}</strong>`;
				if (node.italic) t = `<em>${t}</em>`;
				return t;
			}
			return "";
		})
		.join("");
}

const HTML_ESCAPE = /[&<>"']/g;
const HTML_ESCAPE_MAP: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&#39;",
};

function escapeHtml(str: string): string {
	return str.replace(HTML_ESCAPE, (m) => HTML_ESCAPE_MAP[m] ?? m);
}

// ── Individual block → HTML ────────────────────────────────────────────────────

function renderBlock(block: BuilderBlock): string {
	switch (block.type) {
		case "section":
			return renderSection(block as BuilderSectionBlock);
		case "columns":
			return renderColumns(block as BuilderColumnsBlock);
		case "richText":
			return renderRichText(block as BuilderRichTextBlock);
		case "image":
			return renderImage(block);
		case "button":
			return renderButton(block);
		case "spacer":
			return renderSpacer(block);
		case "divider":
			return renderDivider(block);
		case "container":
			return renderContainer(block);
		default:
			return `<!-- unknown block type: ${(block as BuilderBlock).type} -->`;
	}
}

function renderSection(block: BuilderSectionBlock): string {
	const style = [
		block.props?.background ? `background-color: ${block.props.background}` : "",
		block.props?.padding ? `padding: ${block.props.padding}` : "",
		block.props?.maxWidth ? `max-width: ${block.props.maxWidth}` : "",
		"margin: 0 auto",
	]
		.filter(Boolean)
		.join("; ");

	const children = block.children ?? [];
	const inner = children.map(renderBlock).join("\n");

	return `<section style="${style}">\n${inner}\n</section>`;
}

function renderColumns(block: BuilderColumnsBlock): string {
	const gap = block.props?.gap ?? "1rem";
	const style = `display: grid; grid-template-columns: repeat(${block.columns.length}, 1fr); gap: ${gap}`;

	const colsHtml = block.columns
		.map(
			(col) =>
				`<div style="width: ${col.width ? `${(col.width / 12) * 100}%` : "100%"}">\n${col.blocks
					.map(renderBlock)
					.join("\n")}\n</div>`,
		)
		.join("\n");

	return `<div style="${style}">\n${colsHtml}\n</div>`;
}

function renderRichText(block: BuilderRichTextBlock): string {
	return renderPortableText(block.content);
}

function renderImage(block: BuilderBlock): string {
	// Support both builder image props and existing EmDash ImageBlock props
	const props =
		(
			block as BuilderBlock & {
				props?: { src?: string; url?: string; alt?: string; width?: string; alignment?: string };
			}
		).props ?? {};
	const src = props.src ?? (props as { url?: string }).url ?? "";
	const alt = props.alt ?? "";
	const width = props.width ?? "100%";
	const alignment = props.alignment ?? "center";

	if (!src) return "<!-- image: no src -->";

	return `<div style="text-align: ${alignment}"><img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}" style="width: ${escapeHtml(width)}" /></div>`;
}

function renderButton(block: BuilderBlock): string {
	const props =
		(
			block as BuilderBlock & {
				props?: { text?: string; href?: string; variant?: string; size?: string };
			}
		).props ?? {};
	const text = props.text ?? "Button";
	const href = props.href ?? "#";
	const variant = props.variant ?? "primary";
	const size = props.size ?? "medium";

	return `<a href="${escapeHtml(href)}" class="btn btn-${variant} btn-${size}">${escapeHtml(text)}</a>`;
}

function renderSpacer(block: BuilderBlock): string {
	const props = (block as BuilderBlock & { props?: { height?: string } }).props ?? {};
	const height = props.height ?? "2rem";
	return `<div style="height: ${escapeHtml(height)}" aria-hidden="true"></div>`;
}

function renderDivider(_block: BuilderBlock): string {
	return '<hr style="border: none; border-top: 1px solid var(--line, #d8d0c1); margin: 1rem 0;" />';
}

function renderContainer(block: BuilderBlock): string {
	const props =
		(
			block as BuilderBlock & {
				props?: { background?: string; padding?: string; maxWidth?: string };
			}
		).props ?? {};
	const style = [
		props.background ? `background-color: ${props.background}` : "",
		props.padding ? `padding: ${props.padding}` : "",
		props.maxWidth ? `max-width: ${props.maxWidth}` : "",
		"margin: 0 auto",
	]
		.filter(Boolean)
		.join("; ");

	return `<div style="${style}"></div>`;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a complete BuilderDocument to an HTML string.
 * Used for public page rendering and preview.
 */
export function renderBlockDocument(doc: BuilderDocument): string {
	if (!doc.blocks || doc.blocks.length === 0) {
		return "";
	}

	return doc.blocks.map(renderBlock).join("\n");
}
