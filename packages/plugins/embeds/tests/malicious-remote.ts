import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export const XSS = `<img src=x onerror="alert(1)"><script>alert(2)</script><a href="javascript:alert(3)">x</a>`;

/** Serves Gist and Mastodon API responses whose HTML fields carry script payloads. */
export async function startMaliciousServer(): Promise<{ server: Server; origin: string }> {
	const server = createServer((req, res) => {
		res.setHeader("Content-Type", "application/json");
		if (req.url?.startsWith("/gist.json")) {
			res.end(JSON.stringify({ div: XSS, stylesheet: "https://attacker.example/x.css" }));
			return;
		}
		res.end(
			JSON.stringify({
				id: "123",
				url: "javascript:alert(4)",
				uri: "javascript:alert(4)",
				created_at: "2026-01-01T00:00:00.000Z",
				language: "en",
				content: `<p>hello :e: <a href="https://example.com/ok">ok</a> ${XSS}<link rel="stylesheet" href="https://attacker.example/x.css"></p></template></astro-embed-mastodon><div class="fixed">phish</div>`,
				emojis: [{ shortcode: "e", static_url: `x" onerror="alert(5)`, url: "x" }],
				account: {
					display_name: `Mallory ${XSS}`,
					username: "m",
					acct: "m",
					url: "javascript:alert(6)",
					avatar_static: "https://example.com/a.png",
					emojis: [],
				},
				media_attachments: [],
				card: null,
				replies_count: 0,
				reblogs_count: 0,
				favourites_count: 0,
			}),
		);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
