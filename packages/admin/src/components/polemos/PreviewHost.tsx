import * as React from "react";

import { registerSameTabPreview } from "../../lib/same-tab-preview.js";

/** Preview overlay on top of the admin, in this tab. */
export function PolemosPreviewHost() {
	const [url, setUrl] = React.useState<string | null>(null);

	React.useEffect(() => registerSameTabPreview(setUrl), []);

	React.useEffect(() => {
		if (!url) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") setUrl(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [url]);

	if (!url) return null;

	return (
		<div className="polemos-frame" data-polemos-frame="" role="dialog" aria-label="תצוגה">
			<header>
				<strong>תצוגה</strong>
				<button type="button" data-polemos-frame-close="" onClick={() => setUrl(null)}>
					סגירה
				</button>
			</header>
			<iframe title="תצוגה" src={url} />
		</div>
	);
}
