import { Button } from "@cloudflare/kumo";
import { MagnifyingGlass } from "@phosphor-icons/react";
import * as React from "react";

import { API } from "./admin-api.js";

const MAX_RESULTS = 20;

/**
 * Opens the search modal visitors get, against the live index. The modal is
 * only mounted while open: it claims Cmd/Ctrl+K for itself, which the admin
 * uses for its command palette.
 */
export function PreviewSearchButton(props: { onError: (error: unknown) => void }) {
	const [loading, setLoading] = React.useState(false);
	const modal = React.useRef<HTMLElement | null>(null);

	React.useEffect(
		() => () => {
			modal.current?.remove();
		},
		[],
	);

	const open = async () => {
		if (modal.current) return;
		setLoading(true);
		try {
			const { SearchModalSnippet } = await import("@cloudflare/ai-search-snippet/search");
			const element = new SearchModalSnippet();
			const dark = document.documentElement.dataset.mode === "dark";
			for (const [name, value] of Object.entries({
				"api-url": API,
				placeholder: "Search this site",
				"max-results": String(MAX_RESULTS),
				"max-render-results": String(MAX_RESULTS),
				"group-by": "group",
				theme: dark ? "dark" : "light",
				"disable-analytics": "true",
				"request-options": JSON.stringify({ headers: { "X-EmDash-Request": "1" } }),
			})) {
				element.setAttribute(name, value);
			}
			element.addEventListener("close", () => {
				element.remove();
				modal.current = null;
			});
			document.body.appendChild(element);
			modal.current = element;
			element.open();
		} catch (openError) {
			props.onError(openError);
		} finally {
			setLoading(false);
		}
	};

	return (
		<Button
			variant="outline"
			size="sm"
			icon={<MagnifyingGlass />}
			loading={loading}
			onClick={() => void open()}
		>
			Preview search
		</Button>
	);
}
