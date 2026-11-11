/**
 * Co-editing: several people in one entry, each in their own browser context, signed in through
 * the invite flow. Runs on both e2e targets: the Node.js room registry and the Cloudflare Durable
 * Object.
 */

import {
	type Browser,
	type BrowserContext,
	type Locator,
	type Page,
	request,
} from "@playwright/test";

import { AdminPage, expect, test } from "../fixtures";
import { createUser, Role } from "../fixtures/users";

const SLOW = process.env.EMDASH_E2E_TARGET === "cloudflare" ? 2 : 1;
/** How soon an outside write must reach open editors. */
const OUTSIDE_WRITE_MS = 1_000;
/** The room saves 2 s after the last update; this leaves room for a slow dev server. */
const SAVE_MS = 15_000 * SLOW;

const PEOPLE = {
	ana: { name: "Ana Editor", role: Role.EDITOR },
	ben: { name: "Ben Author", role: Role.AUTHOR },
	cara: { name: "Cara Contributor", role: Role.CONTRIBUTOR },
} as const;
type Person = keyof typeof PEOPLE;
type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

interface Editor {
	context: BrowserContext;
	page: Page;
	admin: AdminPage;
	title: Locator;
	excerpt: Locator;
	body: Locator;
	saved: Locator;
}

interface EntryData {
	title: string;
	excerpt?: string;
	body?: string[];
}

function paragraphs(texts: readonly string[]) {
	return texts.map((text, index) => ({
		_type: "block",
		_key: `p${index}`,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `p${index}-span`, text, marks: [] }],
	}));
}

function bodyText(value: unknown): string {
	if (!Array.isArray(value)) return "";
	return value
		.map((block: { children?: { text?: string }[] }) =>
			(block.children ?? []).map((child) => child.text ?? "").join(""),
		)
		.join("\n");
}

/** The circles for the other people in the entry, in the editor bar. */
function avatars(page: Page): Locator {
	return page.getByRole("group", { name: /^\d+ other (person|people) here$/ }).getByRole("button");
}

/** A person's circle, named "Name · Editing …" or "Name · Viewing". */
function avatar(page: Page, person: Person, state = ""): Locator {
	const { name } = PEOPLE[person];
	return avatars(page).and(
		page.getByRole("button", { name: new RegExp(`^\u2068?${name}\u2069? · ${state}`) }),
	);
}

test.describe("Co-editing", () => {
	let baseUrl: string;
	let headers: Record<string, string>;
	let collection: string;
	const states = {} as Record<Person, StorageState>;
	const opened: BrowserContext[] = [];

	async function api(method: string, path: string, data?: unknown): Promise<unknown> {
		const response = await fetch(`${baseUrl}/_emdash/api${path}`, {
			method,
			headers,
			body: data === undefined ? undefined : JSON.stringify(data),
		});
		const text = await response.text();
		expect(response.ok, `${method} ${path} returned ${response.status}: ${text}`).toBe(true);
		return text ? (JSON.parse(text) as { data: unknown }).data : undefined;
	}

	async function storedEntry(id: string): Promise<Record<string, unknown>> {
		const data = (await api("GET", `/content/${collection}/${id}`)) as {
			item: { data: Record<string, unknown> };
		};
		return data.item.data;
	}

	async function revisions(id: string): Promise<{ data: Record<string, unknown> }[]> {
		const data = (await api("GET", `/content/${collection}/${id}/revisions?limit=100`)) as {
			items: { data: Record<string, unknown> }[];
		};
		return data.items;
	}

	/** Creates a draft as `owner`, so the entry is theirs. */
	async function createEntry(owner: Person, entry: EntryData): Promise<string> {
		const context = await request.newContext({
			baseURL: baseUrl,
			storageState: states[owner],
			extraHTTPHeaders: { "X-EmDash-Request": "1" },
		});
		try {
			const response = await context.post(`/_emdash/api/content/${collection}`, {
				data: {
					data: {
						title: entry.title,
						excerpt: entry.excerpt ?? "",
						body: paragraphs(entry.body ?? []),
					},
					slug: `entry-${crypto.randomUUID()}`,
				},
			});
			expect(response.ok(), await response.text()).toBe(true);
			return ((await response.json()) as { data: { item: { id: string } } }).data.item.id;
		} finally {
			await context.dispose();
		}
	}

	async function signIn(browser: Browser, person: Person): Promise<BrowserContext> {
		const context = await browser.newContext({ baseURL: baseUrl, storageState: states[person] });
		opened.push(context);
		return context;
	}

	function editorOn(context: BrowserContext, page: Page): Editor {
		return {
			context,
			page,
			admin: new AdminPage(page),
			title: page.locator("#field-title"),
			excerpt: page.locator("#field-excerpt"),
			body: page.locator("#field-body .ProseMirror"),
			saved: page.getByRole("button", { name: "Saved", exact: true }).first(),
		};
	}

	/** Opens the entry and waits until it can be edited, or only read with `viewer`. */
	async function openIn(
		context: BrowserContext,
		id: string,
		options: { page?: Page; viewer?: boolean } = {},
	): Promise<Editor> {
		const editor = editorOn(context, options.page ?? (await context.newPage()));
		await editor.admin.goToEditContent(collection, id);
		await editor.admin.waitForLoading();
		if (options.viewer) {
			await expect(editor.page.getByText("Read-only", { exact: true })).toBeVisible();
		} else {
			await expect(editor.title).toBeEditable({ timeout: 15_000 * SLOW });
			await expect(editor.body).toBeEditable();
		}
		return editor;
	}

	async function open(browser: Browser, person: Person, id: string, viewer = false) {
		return openIn(await signIn(browser, person), id, { viewer });
	}

	/** Types at the end of the body's last paragraph, clicking past the end of its last line. */
	async function typeAtBodyEnd(editor: Editor, text: string, delay = 20): Promise<void> {
		await placeCaretAtBodyEnd(editor);
		await editor.page.keyboard.type(text, { delay });
	}

	async function placeCaretAtBodyEnd(editor: Editor): Promise<void> {
		const paragraph = editor.body.locator("p").last();
		const box = await paragraph.boundingBox();
		await paragraph.click({ position: { x: box!.width - 2, y: box!.height - 4 } });
	}

	async function publish(editor: Editor): Promise<void> {
		await editor.page.getByRole("button", { name: "Publish now", exact: true }).click();
		const dialog = editor.page.getByRole("dialog", { name: "Publish now?" });
		await dialog.getByRole("button", { name: "Publish now", exact: true }).click();
		await expect(dialog).toBeHidden({ timeout: 15_000 * SLOW });
	}

	/** The body's paragraphs, without the other people's cursors and their names. */
	function textOf(editor: Editor): Promise<string> {
		return editor.body.evaluate((element) => {
			const copy = element.cloneNode(true) as HTMLElement;
			for (const caret of copy.querySelectorAll(".emdash-remote-caret")) caret.remove();
			return Array.from(copy.querySelectorAll("p"), (paragraph) => paragraph.textContent).join(
				"\n",
			);
		});
	}

	/** Waits until every editor shows the same body text, and returns it. */
	async function convergedBody(...editors: Editor[]): Promise<string> {
		let text = "";
		await expect
			.poll(
				async () => {
					const texts = await Promise.all(editors.map(textOf));
					text = texts[0]!;
					return texts.every((each) => each === text);
				},
				{ timeout: SAVE_MS },
			)
			.toBe(true);
		return text;
	}

	test.beforeAll(async ({ browser, serverInfo }) => {
		test.setTimeout(240_000 * SLOW);
		baseUrl = serverInfo.baseUrl;
		headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${serverInfo.token}`,
			"X-EmDash-Request": "1",
			Origin: baseUrl,
		};

		for (const person of Object.keys(PEOPLE) as Person[]) {
			const context = await createUser(browser, PEOPLE[person]);
			try {
				const dismissed = await context.request.post("/_emdash/api/auth/me", {
					headers: { "X-EmDash-Request": "1" },
					data: { action: "dismissWelcome" },
				});
				expect(dismissed.status()).toBe(200);
				states[person] = await context.storageState();
			} finally {
				await context.close();
			}
		}

		collection = `co_edit_${Date.now()}`;
		await api("POST", "/schema/collections", {
			slug: collection,
			label: "Co-edited Posts",
			labelSingular: "Co-edited Post",
			supports: ["drafts", "revisions", "seo"],
		});
		const fields = `/schema/collections/${collection}/fields`;
		await api("POST", fields, { slug: "title", type: "string", label: "Title", required: true });
		await api("POST", fields, { slug: "excerpt", type: "text", label: "Excerpt" });
		await api("POST", fields, { slug: "body", type: "portableText", label: "Body" });
	});

	test.afterEach(async () => {
		await Promise.all(opened.splice(0).map((context) => context.close()));
	});

	test.afterAll(async () => {
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collection}?force=true`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});

	test("the RFC example: Ana and Ben edit, go offline, take an outside write and publish", async ({
		browser,
	}) => {
		test.setTimeout(180_000 * SLOW);
		const id = await createEntry("ben", {
			title: "Spring launch",
			body: ["Ben rewrites this paragraph."],
		});
		const ben = await open(browser, "ben", id);
		const ana = await open(browser, "ana", id);

		await test.step("each sees the other, and Ben's cursor in rich text", async () => {
			await expect(avatars(ana.page)).toHaveCount(1);
			await expect(avatar(ana.page, "ben")).toBeVisible();
			await expect(avatars(ben.page)).toHaveCount(1);
			await expect(avatar(ben.page, "ana")).toBeVisible();

			const typing = typeAtBodyEnd(ben, " Now with more detail.", 80);
			await expect(
				ana.body.locator(".emdash-remote-caret-label", { hasText: PEOPLE.ben.name }),
			).toHaveCSS("opacity", "1");
			await ana.title.fill("Spring launch: the final plan");
			await typing;
		});

		await test.step("both edits converge and save", async () => {
			await expect(ana.body).toContainText("Ben rewrites this paragraph. Now with more detail.");
			await expect(ben.title).toHaveValue("Spring launch: the final plan");
			await expect(ana.saved).toBeVisible({ timeout: SAVE_MS });
			await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });
			await expect
				.poll(async () => {
					const stored = await storedEntry(id);
					return [stored.title, bodyText(stored.body)];
				})
				.toEqual([
					"Spring launch: the final plan",
					"Ben rewrites this paragraph. Now with more detail.",
				]);
		});

		await test.step("Ben keeps typing through 20 s offline", async () => {
			await ben.context.setOffline(true);
			const offlineAt = Date.now();
			await typeAtBodyEnd(ben, " Typed offline.");
			await expect(
				ben.page.getByRole("button", { name: "Offline", exact: true }).first(),
			).toBeVisible({ timeout: 15_000 });
			expect(Date.now() - offlineAt).toBeGreaterThanOrEqual(5_000);
			const more = " Still offline.";
			const remaining = Math.max(0, 20_000 - (Date.now() - offlineAt));
			await ben.page.keyboard.type(more, { delay: Math.ceil(remaining / more.length) });
			await expect(ana.body).not.toContainText("Typed offline.");

			await ben.context.setOffline(false);
			await expect(ana.body).toContainText("Typed offline. Still offline.", {
				timeout: SAVE_MS,
			});
			await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });
			await expect
				.poll(async () => bodyText((await storedEntry(id)).body))
				.toContain("Typed offline. Still offline.");
		});

		await test.step("a script's write reaches both editors within a second", async () => {
			await api("PUT", `/content/${collection}/${id}`, {
				data: { excerpt: "Written by a script." },
			});
			await Promise.all([
				expect(ana.excerpt).toHaveValue("Written by a script.", { timeout: OUTSIDE_WRITE_MS }),
				expect(ben.excerpt).toHaveValue("Written by a script.", { timeout: OUTSIDE_WRITE_MS }),
			]);
		});

		await test.step("Ana publishes, and Ben's later edits are unpublished changes", async () => {
			await publish(ana);
			await typeAtBodyEnd(ben, " After publishing.");
			await expect(ana.body).toContainText("After publishing.", { timeout: SAVE_MS });
			await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });
			for (const editor of [ana, ben]) {
				await expect(
					editor.page.getByRole("button", { name: "Publish changes", exact: true }),
				).toBeVisible({ timeout: SAVE_MS });
			}
		});
	});

	test("two tabs of one user converge, and neither shows its own user", async ({ browser }) => {
		test.setTimeout(90_000 * SLOW);
		const id = await createEntry("ben", { title: "Two tabs", body: ["One paragraph."] });
		const context = await signIn(browser, "ben");
		const first = await openIn(context, id);
		const second = await openIn(context, id);

		await first.title.fill("Two tabs, one title");
		await expect(second.title).toHaveValue("Two tabs, one title");
		await typeAtBodyEnd(second, " Typed in the second tab.");
		await expect(first.body).toContainText("One paragraph. Typed in the second tab.");
		await expect(avatars(first.page)).toHaveCount(0);
		await expect(avatars(second.page)).toHaveCount(0);

		const ana = await open(browser, "ana", id);
		await expect(avatars(ana.page)).toHaveCount(1);
		await expect(avatar(ana.page, "ben")).toBeVisible();
		for (const tab of [first, second]) {
			await expect(avatars(tab.page)).toHaveCount(1);
			await expect(avatar(tab.page, "ana")).toBeVisible();
		}
		await expect(first.saved).toBeVisible({ timeout: SAVE_MS });
		await expect(second.saved).toBeVisible({ timeout: SAVE_MS });
	});

	test("a viewer sees edits live, can't edit, and shows only as an avatar", async ({ browser }) => {
		test.setTimeout(90_000 * SLOW);
		const id = await createEntry("ben", { title: "Watched", body: ["A paragraph by Ben."] });
		const ben = await open(browser, "ben", id);
		const cara = await open(browser, "cara", id, true);

		await expect(cara.page.getByText("Your role can't edit this entry.")).toBeVisible();
		await expect(cara.title).not.toBeEditable();
		await expect(cara.body).toHaveAttribute("contenteditable", "false");

		await expect(avatar(ben.page, "cara", "Viewing")).toBeVisible();
		await ben.title.fill("Watched live");
		await typeAtBodyEnd(ben, " Typed while Cara watches.");
		await expect(cara.title).toHaveValue("Watched live");
		await expect(cara.body).toContainText("A paragraph by Ben. Typed while Cara watches.");

		// Viewers have no cursor or field, so nothing but the avatar names Cara.
		await expect(
			ben.page.locator(".emdash-presence-pill", { hasText: PEOPLE.cara.name }),
		).toHaveCount(0);
		await expect(avatar(ben.page, "cara", "Viewing")).toBeVisible();
		await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });
	});

	test("a Contributor co-edits their draft, then views it once an Editor publishes", async ({
		browser,
	}) => {
		test.setTimeout(120_000 * SLOW);
		const id = await createEntry("cara", { title: "Cara's draft", body: ["Cara's paragraph."] });
		const cara = await open(browser, "cara", id);
		const ana = await open(browser, "ana", id);

		await typeAtBodyEnd(cara, " Cara adds a line.");
		await ana.title.fill("Cara's draft, edited by Ana");
		await expect(cara.title).toHaveValue("Cara's draft, edited by Ana");
		await expect(ana.body).toContainText("Cara's paragraph. Cara adds a line.");
		await expect(cara.saved).toBeVisible({ timeout: SAVE_MS });
		await expect(ana.saved).toBeVisible({ timeout: SAVE_MS });

		await publish(ana);
		await expect(
			cara.page.getByText("Your role can edit your own entries only while they are drafts."),
		).toBeVisible({ timeout: SAVE_MS });
		await expect(cara.title).not.toBeEditable();
		await expect(avatar(ana.page, "cara", "Viewing")).toBeVisible();

		await ana.title.fill("Published, and still edited");
		await expect(cara.title).toHaveValue("Published, and still edited");
	});

	test("restoring and discarding while others type", async ({ browser }) => {
		test.setTimeout(180_000 * SLOW);
		const id = await createEntry("ben", {
			title: "Versions",
			excerpt: "First excerpt",
			body: ["First draft."],
		});
		await api("PUT", `/content/${collection}/${id}`, {
			data: { excerpt: "Second excerpt", body: paragraphs(["Second draft."]) },
		});
		const ben = await open(browser, "ben", id);
		const ana = await open(browser, "ana", id);

		await test.step("a restore while Ben types", async () => {
			await typeAtBodyEnd(ben, " Ben adds this.");
			await expect(ana.body).toContainText("Second draft. Ben adds this.");
			await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });

			await ana.page.getByRole("button", { name: /^Revisions/ }).click();
			const rows = ana.page.locator("[data-revision-row]");
			await expect(rows).toHaveCount(3);
			await rows.last().click();
			const typing = ben.page.keyboard.type(" Typed during the restore.", { delay: 60 });
			await ana.page.getByRole("button", { name: "Restore", exact: true }).click();
			const dialog = ana.page.getByRole("dialog", { name: "Restore this version?" });
			await dialog.getByRole("button", { name: "Restore", exact: true }).click();
			await expect(ana.page.getByRole("heading", { name: "Version restored" })).toBeVisible({
				timeout: SAVE_MS,
			});
			await typing;

			for (const editor of [ana, ben]) {
				await expect(editor.body).toContainText("First draft.", { timeout: SAVE_MS });
				await expect(editor.body).not.toContainText("Second draft.");
				await expect(editor.excerpt).toHaveValue("First excerpt");
			}
			await typeAtBodyEnd(ben, " Typed after the restore.");
			// Keystrokes from during the restore land wherever the restore left Ben's caret.
			const body = await convergedBody(ana, ben);
			expect(body).toContain("First draft.");
			expect(body.endsWith(" Typed after the restore.")).toBe(true);
			await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });

			// The restore replaced Ben's addition, as restores do, and a revision still holds it.
			await expect
				.poll(async () =>
					(await revisions(id)).some((revision) =>
						bodyText(revision.data.body).includes("Second draft. Ben adds this."),
					),
				)
				.toBe(true);
		});

		await test.step("a discard while Ben types", async () => {
			await publish(ana);
			const live = await convergedBody(ana, ben);
			await typeAtBodyEnd(ben, " Draft only.");
			const discard = ana.page.getByRole("button", { name: "Discard changes", exact: true });
			await expect(discard).toBeVisible({ timeout: SAVE_MS });

			const typing = ben.page.keyboard.type(" Typed during the discard.", { delay: 60 });
			await discard.click();
			const dialog = ana.page.getByRole("dialog", { name: "Discard draft changes?" });
			await dialog.getByRole("button", { name: "Discard changes", exact: true }).click();
			await expect(dialog).toBeHidden({ timeout: SAVE_MS });
			await typing;

			for (const editor of [ana, ben]) {
				await expect(editor.body).not.toContainText("Draft only.", { timeout: SAVE_MS });
			}
			await typeAtBodyEnd(ben, " Typed after the discard.");
			const body = await convergedBody(ana, ben);
			expect(body).toContain(live);
			expect(body.endsWith(" Typed after the discard.")).toBe(true);
			await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });

			// The discard dropped the draft, and a revision still holds it.
			await expect
				.poll(async () =>
					(await revisions(id)).some((revision) =>
						bodyText(revision.data.body).includes("Draft only."),
					),
				)
				.toBe(true);
		});
	});

	test("a reset saves the tab's edits as a recovery revision and rejoins", async ({ browser }) => {
		test.setTimeout(150_000 * SLOW);
		const id = await createEntry("ben", { title: "Reset", body: ["Before the reset."] });
		const ben = await open(browser, "ben", id);
		const ana = await open(browser, "ana", id);
		const before = (await revisions(id)).length;

		// One update over the room's 1 MB limit closes the socket with a reset.
		const marker = "Too large to merge. ";
		await ben.title.fill("Reset, with an unsaved title");
		await ben.excerpt.fill(marker + "x".repeat(1_100_000));
		await expect(ben.page.getByText("Your unsaved edits are in a recovery revision")).toBeVisible({
			timeout: SAVE_MS,
		});

		await expect(ben.excerpt).toHaveValue("", { timeout: SAVE_MS });
		await expect(ben.title).toBeEditable();
		await ben.title.fill("Reset, and editing again");
		await expect(ana.title).toHaveValue("Reset, and editing again", { timeout: SAVE_MS });
		await expect(ben.saved).toBeVisible({ timeout: SAVE_MS });

		const recovered = (await revisions(id)).filter(
			({ data }) => typeof data.excerpt === "string" && data.excerpt.startsWith(marker),
		);
		expect(recovered).toHaveLength(1);
		expect(recovered[0]!.data.title).toBe("Reset, with an unsaved title");

		await ben.page.getByRole("button", { name: /^Revisions/ }).click();
		await expect(ben.page.locator("[data-revision-row]")).toHaveCount((await revisions(id)).length);
		expect((await revisions(id)).length).toBeGreaterThan(before);
	});

	test("outside writes appear live: a REST write and an SEO change", async ({ browser }) => {
		test.setTimeout(90_000 * SLOW);
		const id = await createEntry("ben", { title: "Outside writes", body: ["Paragraph."] });
		const ben = await open(browser, "ben", id);
		const ana = await open(browser, "ana", id);

		await api("PUT", `/content/${collection}/${id}`, {
			data: { title: "Retitled by a script" },
			seo: { description: "Described by a script" },
		});
		await Promise.all([
			expect(ana.title).toHaveValue("Retitled by a script", { timeout: OUTSIDE_WRITE_MS }),
			expect(ben.title).toHaveValue("Retitled by a script", { timeout: OUTSIDE_WRITE_MS }),
		]);
		for (const editor of [ana, ben]) {
			await expect(editor.page.getByLabel("Meta Description")).toHaveValue(
				"Described by a script",
				{ timeout: SAVE_MS },
			);
		}

		await ana.page.getByLabel("SEO Title").fill("Titled for search by Ana");
		await ana.page.getByLabel("SEO Title").blur();
		await expect(ben.page.getByLabel("SEO Title")).toHaveValue("Titled for search by Ana", {
			timeout: SAVE_MS,
		});
		await expect
			.poll(async () => {
				const data = (await api("GET", `/content/${collection}/${id}`)) as {
					item: { seo?: { title?: string | null } };
				};
				return data.item.seo?.title;
			})
			.toBe("Titled for search by Ana");
	});

	test("blocked WebSockets fall back to single-editor mode for the browser session", async ({
		browser,
	}) => {
		test.setTimeout(120_000 * SLOW);
		const id = await createEntry("ben", { title: "No sockets", body: ["Paragraph."] });
		const context = await signIn(browser, "ben");
		let attempts = 0;
		await context.routeWebSocket(/\/room\?token=/, async (socket) => {
			attempts++;
			await socket.close();
		});

		const page = await context.newPage();
		const ben = editorOn(context, page);
		await ben.admin.goToEditContent(collection, id);
		await expect.poll(() => attempts, { timeout: 30_000 * SLOW }).toBe(3);
		await expect(ben.title).toBeEditable({ timeout: 15_000 * SLOW });
		await expect
			.poll(async () => {
				const lock = (await api("GET", `/content/${collection}/${id}/lock`)) as {
					holder: { userName: string | null } | null;
				};
				return lock.holder?.userName;
			})
			.toBe(PEOPLE.ben.name);

		const anaContext = await signIn(browser, "ana");
		const ana = editorOn(anaContext, await anaContext.newPage());
		await ana.admin.goToEditContent(collection, id);
		const lockDialog = ana.page.getByRole("alertdialog", {
			name: "This entry is open somewhere else",
		});
		await expect(lockDialog).toBeVisible({ timeout: 15_000 * SLOW });
		await expect(lockDialog).toContainText(`${PEOPLE.ben.name} is editing this entry.`);

		await page.reload();
		await ben.admin.waitForShell();
		await expect(ben.title).toBeEditable({ timeout: 15_000 * SLOW });
		await ben.title.fill("Saved without a room");
		await expect
			.poll(async () => (await storedEntry(id)).title, { timeout: SAVE_MS })
			.toBe("Saved without a room");
		expect(attempts).toBe(3);
	});

	test("reports how quickly remote edits render", async ({ browser }) => {
		test.setTimeout(90_000 * SLOW);
		const id = await createEntry("ben", { title: "Latency", body: ["Watch this line"] });
		const ben = await open(browser, "ben", id);
		const ana = await open(browser, "ana", id);
		await expect(avatar(ana.page, "ben")).toBeVisible();

		const keystrokes = 50;
		await ana.body.evaluate((element) => {
			const seen: number[] = [];
			const count = () => (element.textContent?.match(/q/g) ?? []).length;
			new MutationObserver(() => {
				const now = Date.now();
				while (seen.length < count()) seen.push(now);
			}).observe(element, { subtree: true, childList: true, characterData: true });
			(window as unknown as { seen: number[] }).seen = seen;
		});
		await placeCaretAtBodyEnd(ben);
		await ben.page.evaluate(() => {
			const sent: number[] = [];
			document.addEventListener("keydown", (event) => {
				if (event.key === "q") sent.push(Date.now());
			});
			(window as unknown as { sent: number[] }).sent = sent;
		});
		await ben.page.keyboard.type("q".repeat(keystrokes), { delay: 100 });
		await expect
			.poll(() => ana.page.evaluate(() => (window as unknown as { seen: number[] }).seen.length))
			.toBe(keystrokes);

		const sent = await ben.page.evaluate(() => (window as unknown as { sent: number[] }).sent);
		const seen = await ana.page.evaluate(() => (window as unknown as { seen: number[] }).seen);
		const latencies = seen.map((at, index) => at - sent[index]!).toSorted((a, b) => a - b);
		const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1]!;
		// Reported, not asserted: shared CI runners are too noisy for a timing gate.
		const summary = `${p95} ms over ${keystrokes} keystrokes (median ${latencies[keystrokes / 2]} ms, goal under 500 ms)`;
		test.info().annotations.push({ type: "remote render p95", description: summary });
		console.log(`[co-editing] remote render p95: ${summary}`);
	});
});
