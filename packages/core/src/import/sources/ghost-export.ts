import type {
	AttachmentInfo,
	FetchOptions,
	ImportAnalysis,
	ImportContext,
	ImportFieldDef,
	ImportSource,
	NormalizedItem,
	PostTypeAnalysis,
	SourceInput,
} from "../types.js";
import { checkSchemaCompatibility, mapPostTypeToCollection } from "../utils.js";
import {
	buildGhostAuthorPostCounts,
	buildGhostPrimaryAuthorByPostId,
	buildGhostTagSlugsByPostId,
	getGhostSettingValue,
	parseGhostExportString,
} from "../ghost/parser.js";
import { buildGhostExcerpt, normalizeGhostMediaUrl } from "../ghost/rewrite.js";

const GHOST_REQUIRED_FIELDS: ImportFieldDef[] = [
	{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
	{ slug: "body_html", label: "Body HTML", type: "text", required: false, searchable: true },
	{ slug: "body_text", label: "Body Text", type: "text", required: false, searchable: true },
	{ slug: "excerpt", label: "Excerpt", type: "text", required: false },
	{ slug: "featured_image_url", label: "Featured Image URL", type: "string", required: false },
	{ slug: "visibility", label: "Visibility", type: "string", required: false },
];

function mapGhostStatus(status: string | null | undefined): NormalizedItem["status"] {
	switch (status) {
		case "published":
			return "publish";
		case "scheduled":
			return "future";
		case "private":
			return "private";
		case "draft":
		default:
			return "draft";
	}
}

export const ghostExportSource: ImportSource = {
	id: "ghost-export",
	name: "Ghost Export File",
	description: "Upload a Ghost JSON export file",
	icon: "upload",
	requiresFile: true,
	canProbe: false,

	async analyze(input: SourceInput, context: ImportContext): Promise<ImportAnalysis> {
		if (input.type !== "file") {
			throw new Error("Ghost export source requires a file input");
		}

		const text = await input.file.text();
		const ghost = parseGhostExportString(text);
		const existingCollections = context.getExistingCollections
			? await context.getExistingCollections()
			: new Map();
		const postCounts = new Map<string, number>();
		for (const post of ghost.posts) {
			postCounts.set(post.type, (postCounts.get(post.type) ?? 0) + 1);
		}

		const postTypes: PostTypeAnalysis[] = Array.from(postCounts.entries(), ([name, count]) => {
			const suggestedCollection = mapPostTypeToCollection(name);
			const existingCollection = existingCollections.get(suggestedCollection);
			return {
				name,
				count,
				suggestedCollection,
				requiredFields: GHOST_REQUIRED_FIELDS,
				schemaStatus: checkSchemaCompatibility(GHOST_REQUIRED_FIELDS, existingCollection),
			};
		}).toSorted((a, b) => b.count - a.count);

		const authorPostCounts = buildGhostAuthorPostCounts(ghost);
		const attachments: AttachmentInfo[] = ghost.posts
			.filter((post) => Boolean(post.feature_image))
			.map((post) => ({
				id: post.id,
				title: post.title ?? post.slug,
				url: normalizeGhostMediaUrl(post.feature_image),
				filename: post.feature_image?.split("/").pop(),
			}));

		return {
			sourceId: "ghost-export",
			site: {
				title: getGhostSettingValue(ghost, "title") ?? "Ghost export",
				url: getGhostSettingValue(ghost, "url") ?? "",
			},
			postTypes,
			attachments: {
				count: attachments.length,
				items: attachments,
			},
			categories: 0,
			tags: ghost.tags.length,
			authors: ghost.users.map((user) => ({
				id: user.id,
				login: user.slug ?? undefined,
				email: user.email ?? undefined,
				displayName: user.name ?? user.slug ?? undefined,
				postCount: authorPostCounts.get(user.id) ?? 0,
			})),
		};
	},

	async *fetchContent(input: SourceInput, options: FetchOptions): AsyncGenerator<NormalizedItem> {
		if (input.type !== "file") {
			throw new Error("Ghost export source requires a file input");
		}

		const text = await input.file.text();
		const ghost = parseGhostExportString(text);
		const tagSlugsByPostId = buildGhostTagSlugsByPostId(ghost);
		const primaryAuthors = buildGhostPrimaryAuthorByPostId(ghost);
		let count = 0;

		for (const post of ghost.posts) {
			if (!options.postTypes.includes(post.type)) {
				continue;
			}

			if (!options.includeDrafts && post.status !== "published") {
				continue;
			}

			const excerpt = buildGhostExcerpt(post, post.html ?? "");
			const author = primaryAuthors.get(post.id);
			yield {
				sourceId: post.id,
				postType: post.type,
				status: mapGhostStatus(post.status),
				slug: post.slug,
				title: post.title ?? post.slug,
				content: [],
				html: post.html ?? "",
				excerpt,
				date: new Date(post.published_at || post.created_at || post.updated_at || Date.now()),
				modified: post.updated_at ? new Date(post.updated_at) : undefined,
				author: author?.slug ?? author?.email ?? author?.name ?? undefined,
				tags: tagSlugsByPostId.get(post.id) ?? [],
				featuredImage: normalizeGhostMediaUrl(post.feature_image),
				sourcePath: `/${post.slug}/`,
				visibility: post.visibility ?? "public",
				meta: {
					ghostId: post.id,
					plaintext: post.plaintext ?? undefined,
				},
				locale: post.locale ?? undefined,
			};

			count++;
			if (options.limit && count >= options.limit) {
				break;
			}
		}
	},
};
