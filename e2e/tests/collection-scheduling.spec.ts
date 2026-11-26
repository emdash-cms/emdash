import { test, expect } from "../fixtures";

interface Scenario {
	collection: string;
	contentId: string;
	headers: Record<string, string>;
	baseUrl: string;
}

function headers(baseUrl: string, token: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

async function createScenario(
	baseUrl: string,
	token: string,
	supports: string[],
): Promise<Scenario> {
	const requestHeaders = headers(baseUrl, token);
	const collection = `schedule_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
	const collectionResponse = await fetch(`${baseUrl}/_emdash/api/schema/collections`, {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({
			slug: collection,
			label: "Scheduling Test",
			labelSingular: "Scheduling Test",
			supports,
		}),
	});
	expect(collectionResponse.status).toBe(201);

	const fieldResponse = await fetch(
		`${baseUrl}/_emdash/api/schema/collections/${collection}/fields`,
		{
			method: "POST",
			headers: requestHeaders,
			body: JSON.stringify({ slug: "title", type: "string", label: "Title", required: true }),
		},
	);
	expect(fieldResponse.ok).toBe(true);

	const contentResponse = await fetch(`${baseUrl}/_emdash/api/content/${collection}`, {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({
			data: { title: "Scheduling regression" },
			slug: "scheduling-regression",
		}),
	});
	expect(contentResponse.status).toBe(201);
	const content = await json(contentResponse);
	const item = content.data as { item?: { id: string }; id?: string };
	const contentId = item.item?.id ?? item.id;
	expect(contentId).toBeTruthy();
	return { collection, contentId: contentId!, headers: requestHeaders, baseUrl };
}

async function getEntry(scenario: Scenario): Promise<Record<string, unknown>> {
	const response = await fetch(
		`${scenario.baseUrl}/_emdash/api/content/${scenario.collection}/${scenario.contentId}`,
		{ headers: scenario.headers },
	);
	const body = await json(response);
	return (
		(body.data as { item?: Record<string, unknown> }).item ?? (body.data as Record<string, unknown>)
	);
}

async function schedule(
	scenario: Scenario,
): Promise<{ response: Response; body: Record<string, unknown> }> {
	const response = await fetch(
		`${scenario.baseUrl}/_emdash/api/content/${scenario.collection}/${scenario.contentId}/schedule`,
		{
			method: "POST",
			headers: scenario.headers,
			body: JSON.stringify({ scheduledAt: new Date(Date.now() + 86_400_000).toISOString() }),
		},
	);
	return { response, body: await json(response) };
}

async function cleanup(scenario: Scenario): Promise<void> {
	await fetch(
		`${scenario.baseUrl}/_emdash/api/content/${scenario.collection}/${scenario.contentId}`,
		{ method: "DELETE", headers: scenario.headers },
	).catch(() => {});
	await fetch(`${scenario.baseUrl}/_emdash/api/schema/collections/${scenario.collection}`, {
		method: "DELETE",
		headers: scenario.headers,
	}).catch(() => {});
}

test.describe("Collection scheduling opt-out", () => {
	test("accepts no-scheduling, hides Schedule, and rejects scheduling without changing the draft", async ({
		admin,
		page,
		serverInfo,
	}) => {
		await admin.devBypassAuth();
		const scenario = await createScenario(serverInfo.baseUrl, serverInfo.token, [
			"drafts",
			"revisions",
			"no-scheduling",
		]);
		try {
			const schemaResponse = await fetch(
				`${scenario.baseUrl}/_emdash/api/schema/collections/${scenario.collection}`,
				{ headers: scenario.headers },
			);
			const schema = await json(schemaResponse);
			const savedSupports = (schema.data as { item: { supports: string[] } }).item.supports;
			expect(savedSupports).toContain("no-scheduling");

			const before = await getEntry(scenario);
			const rejected = await schedule(scenario);
			expect(rejected.response.status).toBe(400);
			expect(rejected.body.error).toMatchObject({ code: "VALIDATION_ERROR" });
			expect(await getEntry(scenario)).toEqual(before);

			await admin.goToEditContent(scenario.collection, scenario.contentId);
			await admin.waitForLoading();
			await expect(page.locator("#field-title")).toHaveValue("Scheduling regression");
			await expect(page.getByRole("button", { name: "Schedule", exact: true })).toHaveCount(0);
		} finally {
			await cleanup(scenario);
		}
	});

	test("removing the opt-out restores API scheduling", async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		const scenario = await createScenario(serverInfo.baseUrl, serverInfo.token, [
			"drafts",
			"revisions",
			"no-scheduling",
		]);
		try {
			const update = await fetch(
				`${scenario.baseUrl}/_emdash/api/schema/collections/${scenario.collection}`,
				{
					method: "PUT",
					headers: scenario.headers,
					body: JSON.stringify({ supports: ["drafts", "revisions"] }),
				},
			);
			expect(update.ok).toBe(true);
			const scheduled = await schedule(scenario);
			expect(scheduled.response.status).toBe(200);
			expect(await getEntry(scenario)).toMatchObject({ scheduledAt: expect.any(String) });
		} finally {
			await cleanup(scenario);
		}
	});

	test("disabling scheduling keeps Remove schedule but hides Change schedule", async ({
		admin,
		page,
		serverInfo,
	}) => {
		await admin.devBypassAuth();
		const scenario = await createScenario(serverInfo.baseUrl, serverInfo.token, [
			"drafts",
			"revisions",
		]);
		try {
			await admin.goToEditContent(scenario.collection, scenario.contentId);
			await admin.waitForLoading();
			await expect(page.getByRole("button", { name: "Schedule", exact: true })).toBeVisible();
			const scheduled = await schedule(scenario);
			expect(scheduled.response.status).toBe(200);
			await admin.goToEditContent(scenario.collection, scenario.contentId);
			await admin.waitForLoading();
			await expect(
				page.getByRole("button", { name: "Change schedule", exact: true }),
			).toBeVisible();
			await expect(
				page.getByRole("button", { name: "Remove schedule", exact: true }),
			).toBeVisible();

			const month = String((await getEntry(scenario)).scheduledAt).slice(0, 7);
			const calendarUrl = `${scenario.baseUrl}/_emdash/admin/calendar?month=${month}&view=agenda`;
			await page.goto(calendarUrl);
			await page.getByRole("link", { name: /Scheduling regression/ }).click();
			const panel = page.getByRole("dialog", { name: "Scheduling regression" });
			await expect(panel.getByRole("button", { name: "Reschedule", exact: true })).toBeVisible();

			const update = await fetch(
				`${scenario.baseUrl}/_emdash/api/schema/collections/${scenario.collection}`,
				{
					method: "PUT",
					headers: scenario.headers,
					body: JSON.stringify({ supports: ["drafts", "revisions", "no-scheduling"] }),
				},
			);
			expect(update.ok).toBe(true);
			await admin.goToEditContent(scenario.collection, scenario.contentId);
			await admin.waitForLoading();
			await expect(page.getByRole("button", { name: "Change schedule", exact: true })).toHaveCount(
				0,
			);
			await expect(
				page.getByRole("button", { name: "Remove schedule", exact: true }),
			).toBeVisible();
			await page.goto(calendarUrl);
			await page.getByRole("link", { name: /Scheduling regression/ }).click();
			await expect(panel.getByRole("button", { name: "Reschedule", exact: true })).toHaveCount(0);
			await expect(
				panel.getByRole("button", { name: "Remove schedule", exact: true }),
			).toBeVisible();
		} finally {
			await cleanup(scenario);
		}
	});
});
