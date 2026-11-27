import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { isSafeHref } from "../../lib/url.js";

/** Why a menu item's label is refused, if it is. */
export function labelProblem(label: string): MessageDescriptor | undefined {
	return label.trim() ? undefined : msg`Enter a label.`;
}

/** Why a custom link's URL is refused, matching what the server refuses. */
export function urlProblem(value: string): MessageDescriptor | undefined {
	const url = value.trim();
	if (!url) return msg`Enter a URL.`;
	if (url.startsWith("//") || url.startsWith("/\\")) {
		return msg`Enter a path that starts with a single /.`;
	}
	if (!isSafeHref(url)) {
		return msg`Enter a URL that starts with https://, http://, mailto:, tel:, /, or #.`;
	}
	return undefined;
}
