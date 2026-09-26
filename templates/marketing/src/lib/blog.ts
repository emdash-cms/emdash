import type { ContentBylineCredit, MediaValue, PortableTextBlock } from "emdash";

const WORDS_PER_MINUTE = 220;
const WHITESPACE_REGEX = /\s+/;
const DATE_FORMATTER = new Intl.DateTimeFormat("en", {
	year: "numeric",
	month: "long",
	day: "numeric",
});

type PortableTextSpan = {
	_type: string;
	text?: string;
};

type PortableTextTextBlock = PortableTextBlock & {
	_type: "block";
	children: PortableTextSpan[];
};

export interface BlogPostData {
	id: string;
	slug: string | null;
	status: string;
	title: string;
	excerpt?: string;
	category?: string;
	featured?: boolean;
	featured_image?: MediaValue;
	cover_style?: string;
	content?: PortableTextBlock[];
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	bylines?: ContentBylineCredit[];
}

function isTextBlock(block: PortableTextBlock): block is PortableTextTextBlock {
	return block._type === "block" && Array.isArray(block.children);
}

export function getReadingTime(content: PortableTextBlock[] | undefined): number {
	if (!content) return 1;

	const text = content
		.filter(isTextBlock)
		.flatMap((block) => block.children)
		.filter((child) => child._type === "span" && typeof child.text === "string")
		.map((child) => child.text)
		.join(" ");
	const wordCount = text.split(WHITESPACE_REGEX).filter(Boolean).length;

	return Math.max(1, Math.ceil(wordCount / WORDS_PER_MINUTE));
}

export function formatPostDate(date: Date | null | undefined): string | null {
	return date ? DATE_FORMATTER.format(date) : null;
}

export function getPostAuthor(post: BlogPostData) {
	const credit = post.bylines?.[0];
	const name = credit?.byline.displayName || "Editorial team";
	const initials = name
		.split(WHITESPACE_REGEX)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");

	return {
		name,
		initials: initials || "ET",
		role: credit?.roleLabel,
	};
}
