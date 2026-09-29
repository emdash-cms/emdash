import { registryLoader } from "@emdash-cms/registry-loader";
import { defineLiveCollection } from "astro:content";

export const collections = {
	plugins: defineLiveCollection({ loader: registryLoader() }),
};
