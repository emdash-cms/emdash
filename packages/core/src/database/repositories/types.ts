import { encodeBase64, decodeBase64 } from "../../utils/base64.js";

export interface CreateContentInput {
	type: string;
	slug?: string | null;
	data: Record<string, unknown>;
	status?: string;
	visibility?: string;
	authorId?: string;
	primaryBylineId?: string | null;
	locale?: string;
	translationOf?: string;
	publishedAt?: string | null;
}

export interface UpdateContentInput {
	data?: Record<string, unknown>;
	status?: string;
	visibility?: string;
	slug?: string | null;
	publishedAt?: string | null;
	scheduledAt?: string | null;
	authorId?: string | null;
	primaryBylineId?: string | null;
}

/** SEO fields for content items */
export interface ContentSeo {
	title: string | null;
	description: string | null;
	image: string | null;
	canonical: string | null;
	noIndex: boolean;
}

/** Input for updating SEO fields on content */
export interface ContentSeoInput {
	title?: string | null;
	description?: string | null;
	image?: string | null;
	canonical?: string | null;
	noIndex?: boolean;
}

export interface BylineSummary {
	id: string;
	slug: string;
	displayName: string;
	bio: string | null;
	avatarMediaId: string | null;
	websiteUrl: string | null;
	userId: string | null;
	isGuest: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface ContentBylineCredit {
	byline: BylineSummary;
	sortOrder: number;
	roleLabel: string | null;
	/** Whether this credit was explicitly assigned or inferred from authorId */
	source?: "explicit" | "inferred";
}

export interface FindManyOptions {
	where?: {
		status?: string;
		visibility?: string;
		authorId?: string;
		locale?: string;
	};
	orderBy?: {
		field: string;
		direction: "asc" | "desc";
	};
	limit?: number;
	cursor?: string; // Base64-encoded JSON: {orderValue: string, id: string}
}

export interface FindManyResult<T> {
	items: T[];
	nextCursor?: string; // Base64-encoded JSON: {orderValue: string, id: string}
}

/** Encode a cursor from order value + id */
export function encodeCursor(orderValue: string, id: string): string {
	return encodeBase64(JSON.stringify({ orderValue, id }));
}

/** Decode a cursor to order value + id. Returns null if invalid. */
export function decodeCursor(cursor: string): { orderValue: string; id: string } | null {
	try {
		const parsed = JSON.parse(decodeBase64(cursor));
		if (typeof parsed.orderValue === "string" && typeof parsed.id === "string") {
			return parsed;
		}
		return null;
	} catch {
		return null;
	}
}

export interface ContentItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	visibility: string;
	data: Record<string, unknown>;
	authorId: string | null;
	primaryBylineId: string | null;
	byline?: BylineSummary | null;
	bylines?: ContentBylineCredit[];
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	version: number;
	locale: string | null;
	translationGroup: string | null;
	/** SEO metadata — only populated for collections with `has_seo` enabled */
	seo?: ContentSeo;
}

export class EmDashValidationError extends Error {
	constructor(
		message: string,
		public details?: unknown,
	) {
		super(message);
		this.name = "EmDashValidationError";
	}
}
