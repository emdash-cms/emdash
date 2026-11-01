import { registryLoader } from "@emdash-cms/registry-loader";
import { defineLiveCollection } from "astro:content";

import { REGISTRY_CLIENT_OPTIONS } from "./lib/registry.js";

export const collections = {
	plugins: defineLiveCollection({ loader: registryLoader(REGISTRY_CLIENT_OPTIONS) }),
};
