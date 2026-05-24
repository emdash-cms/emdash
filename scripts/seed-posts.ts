/**
 * Seed script -- creates a large number of posts for performance testing.
 *
 * Usage:
 *   npx tsx scripts/seed-posts.ts [count] [base-url]
 *
 * Examples:
 *   npx tsx scripts/seed-posts.ts              # 500 posts on localhost:4321
 *   npx tsx scripts/seed-posts.ts 1000          # 1000 posts
 *   npx tsx scripts/seed-posts.ts 200 http://localhost:3000
 *
 * Requires a running dev server with the dev-bypass auth endpoint.
 */

const COUNT = parseInt(process.argv[2] || "500", 10);
const BASE_URL = process.argv[3] || "http://localhost:4321";
const API_BASE = `${BASE_URL}/_emdash/api`;
const CONCURRENCY = 10;

const TITLES = [
	"Breaking News: Local Events Shake Up Community",
	"The Future of Technology in Everyday Life",
	"How to Build a Sustainable Garden",
	"Understanding Modern Architecture Trends",
	"A Deep Dive into Machine Learning Algorithms",
	"Travel Guide: Hidden Gems of Southeast Asia",
	"The Art of Minimalist Design",
	"Cooking with Seasonal Ingredients",
	"Financial Planning for Young Professionals",
	"The History of Jazz Music in America",
	"Climate Change and Its Impact on Agriculture",
	"A Beginner's Guide to Photography",
	"The Science Behind Sleep and Productivity",
	"Exploring the World of Craft Brewing",
	"Digital Privacy in the Modern Age",
	"The Rise of Remote Work Culture",
	"Understanding Blockchain Beyond Cryptocurrency",
	"The Psychology of Color in Marketing",
	"Sustainable Fashion: A Growing Movement",
	"The Evolution of Video Games as Art",
];

const STATUSES = ["draft", "draft", "draft", "published", "published"];

const PARAGRAPHS = [
	"Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.",
	"Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum.",
	"Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra, est eros bibendum elit, nec luctus magna felis sollicitudin mauris. Integer in mauris eu nibh euismod gravida.",
	"Praesent blandit laoreet nibh. Fusce convallis metus id felis luctus adipiscing. Pellentesque egestas, neque sit amet convallis pulvinar, justo nulla eleifend augue, ac auctor orci leo non est.",
	"Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi architecto beatae vitae dicta sunt explicabo.",
	"Nemo enim ipsam voluptatem quia voluptas sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione voluptatem sequi nesciunt.",
	"At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint occaecati cupiditate non provident.",
	"Nam libero tempore, cum soluta nobis est eligendi optio cumque nihil impedit quo minus id quod maxime placeat facere possimus, omnis voluptas assumenda est, omnis dolor repellendus.",
];

function pick<T>(arr: T[]): T {
	return arr[Math.floor(Math.random() * arr.length)]!;
}

function generatePost(index: number) {
	const baseTitle = pick(TITLES);
	const title = `${baseTitle} (#${index + 1})`;
	const paragraphCount = 2 + Math.floor(Math.random() * 5);
	const content = Array.from({ length: paragraphCount })
		.map(() => pick(PARAGRAPHS))
		.join("\n\n");
	const excerpt = content.slice(0, 150) + "…";

	return {
		data: {
			title,
			content,
			excerpt,
		},
		status: pick(STATUSES),
	};
}

async function authenticate(): Promise<string> {
	const res = await fetch(`${API_BASE}/auth/dev-bypass`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		redirect: "manual",
	});

	const cookie = res.headers.getSetCookie?.()?.join("; ") || res.headers.get("set-cookie") || "";
	if (!cookie) {
		// Try GET with redirect=manual to capture cookie
		const getRes = await fetch(`${API_BASE}/auth/dev-bypass?redirect=/`, {
			redirect: "manual",
		});
		const getCookie =
			getRes.headers.getSetCookie?.()?.join("; ") || getRes.headers.get("set-cookie") || "";
		if (!getCookie) {
			throw new Error("Could not get session cookie from dev-bypass. Is the dev server running?");
		}
		return getCookie;
	}
	return cookie;
}

async function createPost(cookie: string, post: ReturnType<typeof generatePost>): Promise<boolean> {
	try {
		const res = await fetch(`${API_BASE}/content/posts`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
				Cookie: cookie,
			},
			body: JSON.stringify(post),
		});

		if (!res.ok) {
			const text = await res.text();
			console.error(`  ✗ ${res.status}: ${text.slice(0, 200)}`);
			return false;
		}
		return true;
	} catch (err) {
		console.error(`  ✗ Network error: ${err instanceof Error ? err.message : String(err)}`);
		return false;
	}
}

async function runBatch(
	cookie: string,
	posts: ReturnType<typeof generatePost>[],
	_startIndex: number,
): Promise<number> {
	const results = await Promise.all(posts.map((post) => createPost(cookie, post)));
	const succeeded = results.filter(Boolean).length;
	return succeeded;
}

async function main() {
	console.log(`\n🌱 Seeding ${COUNT} posts to ${BASE_URL}\n`);

	// Step 1: Authenticate
	console.log("→ Authenticating via dev-bypass...");
	let cookie: string;
	try {
		cookie = await authenticate();
		console.log("  ✓ Authenticated\n");
	} catch (err) {
		console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	// Step 2: Generate posts
	const posts = Array.from({ length: COUNT }, (_, i) => generatePost(i));

	// Step 3: Create in batches
	let created = 0;
	let failed = 0;
	const startTime = Date.now();

	for (let i = 0; i < posts.length; i += CONCURRENCY) {
		const batch = posts.slice(i, i + CONCURRENCY);
		const succeeded = await runBatch(cookie, batch, i);
		created += succeeded;
		failed += batch.length - succeeded;

		const progress = Math.round(((i + batch.length) / posts.length) * 100);
		const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
		const rate = (created / parseFloat(elapsed)).toFixed(1);
		process.stdout.write(
			`\r→ Progress: ${created}/${COUNT} created (${progress}%) — ${elapsed}s elapsed — ${rate} posts/s`,
		);
	}

	const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
	console.log(`\n\n✓ Done in ${totalTime}s`);
	console.log(`  Created: ${created}`);
	if (failed > 0) console.log(`  Failed:  ${failed}`);
	console.log(`  Rate:    ${(created / parseFloat(totalTime)).toFixed(1)} posts/s\n`);
}

main().catch(console.error);
