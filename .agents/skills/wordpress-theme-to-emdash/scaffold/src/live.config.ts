/**
 * EmDash Live Config
 *
 * This file defines your content collections using EmDash's loader.
 * It replaces Astro's content collections for CMS-managed content.
 */

import { defineCollection } from "astro:content";
import { emdashLoader } from "emdash";

// Posts collection - loaded from EmDash CMS
export const collections = {
	posts: defineCollection({
		loader: emdashLoader({ collection: "posts" }),
	}),
	pages: defineCollection({
		loader: emdashLoader({ collection: "pages" }),
	}),
};
