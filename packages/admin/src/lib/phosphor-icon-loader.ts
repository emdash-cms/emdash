import { Plug } from "@phosphor-icons/react";

import { PHOSPHOR_ICON_MODULE_ALIASES } from "../generated/phosphor-icon-buckets/module-aliases.js";

type PhosphorIconModule = Record<string, unknown>;

const PHOSPHOR_ICON_BUCKETS: ReadonlyArray<() => Promise<PhosphorIconModule>> = [
	() => import("../generated/phosphor-icon-buckets/bucket-00.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-01.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-02.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-03.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-04.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-05.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-06.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-07.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-08.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-09.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-10.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-11.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-12.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-13.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-14.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-15.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-16.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-17.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-18.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-19.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-20.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-21.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-22.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-23.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-24.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-25.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-26.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-27.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-28.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-29.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-30.js"),
	() => import("../generated/phosphor-icon-buckets/bucket-31.js"),
];

function getBucket(name: string): number {
	let hash = 0x811c9dc5;
	for (let index = 0; index < name.length; index++) {
		hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193);
	}
	return (hash >>> 0) & (PHOSPHOR_ICON_BUCKETS.length - 1);
}

export async function loadPhosphorIcon(name: string): Promise<unknown> {
	const alias = Object.hasOwn(PHOSPHOR_ICON_MODULE_ALIASES, name)
		? PHOSPHOR_ICON_MODULE_ALIASES[name]
		: undefined;
	const moduleName = alias ?? (name.endsWith("Icon") ? name.slice(0, -4) : name);
	const loadBucket = PHOSPHOR_ICON_BUCKETS[getBucket(moduleName)];
	if (!loadBucket) return undefined;
	try {
		const bucket = await loadBucket();
		return Object.hasOwn(bucket, name) ? bucket[name] : undefined;
	} catch (error) {
		console.error(`[admin] Failed to load Phosphor icon "${name}":`, error);
		return Plug;
	}
}
