import { z } from "astro/zod";
import type { PluginContentItem } from "emdash";
import { extractSearchableFields } from "emdash";

const EXCERPT_LENGTH = 300;
/** AI Search rejects items whose metadata exceeds about 10 KiB, so display fields are trimmed. */
const TITLE_LENGTH = 300;
const LOCAL_MEDIA_PREFIX = "/_emdash/api/media/file/";
const STORAGE_KEY = /^[A-Za-z0-9._-]+$/;

/** Metadata stored on each AI Search item. Only the declared fields are filterable. */
interface DocumentMetadata {
	source: string;
	locale: string;
	priority: number;
	published_at?: string;
	title: string;
	url: string;
	excerpt: string;
	/** Preview image: a site path or an https URL. */
	image?: string;
	hash: string;
}

/**
 * The metadata fields read back from AI Search. Every value arrives as a
 * string, since uploads stringify them. Items without these fields were not
 * uploaded by this plugin.
 */
const storedMetadataSchema = z.object({
	source: z.string(),
	locale: z.string(),
	title: z.string(),
	url: z.string(),
	excerpt: z.string(),
	image: z.string().optional(),
	hash: z.string(),
});

type StoredMetadata = z.infer<typeof storedMetadataSchema>;

/** An AI Search item's metadata, or null when the plugin did not upload it. */
export function readMetadata(metadata: Record<string, unknown> | undefined): StoredMetadata | null {
	const parsed = storedMetadataSchema.safeParse(metadata);
	return parsed.success ? parsed.data : null;
}

export interface SearchDocument {
	key: string;
	body: string;
	metadata: DocumentMetadata;
	/** Related names added to the body, such as authors and terms. Not uploaded separately. */
	context: ContextLine[];
}

/** A labelled list of related names, such as "Tags: Gardening, Community". */
export interface ContextLine {
	label: string;
	values: string[];
}

export function documentKey(source: string, id: string): string {
	return `${source}/${id}.md`;
}

export function fillTemplate(template: string, slug: string): string {
	return template.replaceAll("{slug}", encodeURIComponent(slug));
}

/** The searchable title and text of an entry's chosen fields. */
export function entryText(
	entry: PluginContentItem,
	titleField: string,
	fields: string[],
): { title: string; text: string } {
	const values = extractSearchableFields(entry.data, [titleField, ...fields]);
	return {
		title: values[titleField]?.trim() || entry.slug || entry.id,
		text: fields
			.filter((field) => field !== titleField)
			.map((field) => values[field]?.trim())
			.filter(Boolean)
			.join("\n\n"),
	};
}

export interface RecordDocumentInput {
	source: string;
	id: string;
	title: string;
	text: string;
	context: ContextLine[];
	locale: string;
	publishedAt?: string | null;
	url: string;
	image: string | undefined;
	priority: number;
}

export async function recordDocument(input: RecordDocumentInput): Promise<SearchDocument> {
	const context = input.context.filter((line) => line.values.length > 0);
	const body = [
		`# ${input.title}`,
		input.text,
		context.map((line) => `${line.label}: ${line.values.join(", ")}`).join("\n"),
	]
		.filter(Boolean)
		.join("\n\n");
	// Key order is part of the hash; changing it re-uploads every item.
	const metadata: Omit<DocumentMetadata, "hash"> = {
		source: input.source,
		locale: input.locale,
		priority: input.priority,
		...(input.publishedAt ? { published_at: input.publishedAt } : {}),
		title: truncate(input.title, TITLE_LENGTH),
		url: input.url,
		excerpt: excerpt(input.text),
		...(input.image ? { image: input.image } : {}),
	};
	const hash = await sha256(JSON.stringify([body, metadata]));
	return {
		key: documentKey(input.source, input.id),
		body,
		metadata: { ...metadata, hash },
		context,
	};
}

/**
 * URL of an image field value: a local upload's file route, or the image's own
 * `src` when it is an https URL or a site path.
 */
export function imageUrl(value: unknown): string | undefined {
	if (!isRecord(value)) return undefined;
	const storageKey = isRecord(value.meta) ? value.meta.storageKey : undefined;
	if (
		value.provider === "local" &&
		typeof storageKey === "string" &&
		STORAGE_KEY.test(storageKey)
	) {
		return `${LOCAL_MEDIA_PREFIX}${storageKey}`;
	}
	return typeof value.src === "string" && isPreviewUrl(value.src) ? value.src : undefined;
}

export function isPreviewUrl(url: string): boolean {
	return url.startsWith("https://") || (url.startsWith("/") && !url.startsWith("//"));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function excerpt(text: string): string {
	return truncate(text.replace(/\s+/g, " ").trim(), EXCERPT_LENGTH);
}

function truncate(text: string, length: number): string {
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
