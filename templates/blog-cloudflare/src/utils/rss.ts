const SRCSET_URL = /^\S+/;

const XML_ENTITIES: Record<string, string> = {
	"&": "&amp;",
	"<": "&lt;",
	">": "&gt;",
	'"': "&quot;",
	"'": "&apos;",
};

export function escapeXml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => XML_ENTITIES[character] ?? character);
}

export function cdata(value: string): string {
	return "<![CDATA[" + value.replace(/\]\]>/g, "]]]]><![CDATA[>") + "]]>";
}

export function absoluteFeedUrls(html: string, postUrl: string): string {
	return html.replace(
		/(\s(?:href|src|poster|srcset))=(["'])(.*?)\2/gi,
		(_match, attribute: string, quote: string, value: string) => {
			const resolve = (url: string) => {
				try {
					return new URL(url, postUrl).href;
				} catch {
					return url;
				}
			};
			const absolute =
				attribute.trim().toLowerCase() === "srcset" && !value.startsWith("data:")
					? value
							.split(",")
							.map((candidate) => candidate.trim().replace(SRCSET_URL, resolve))
							.join(", ")
					: resolve(value);
			return attribute + "=" + quote + absolute + quote;
		},
	);
}
