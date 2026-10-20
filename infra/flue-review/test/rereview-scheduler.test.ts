import { beforeEach, describe, expect, it, vi } from "vitest";

import type { RereviewMove } from "../.flue/lib/github.js";

interface World {
	head: string;
	state: string;
	draft: boolean;
	checks: Map<string, { total: number; incomplete: number }>;
	lastReviewed: string | undefined;
	reviewChecks: Set<string>;
	moves: Map<string, RereviewMove>;
	active: Set<string>;
	reserved: string[];
}

const world = vi.hoisted(() => ({ current: undefined as unknown as World }));

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;
		env: unknown;

		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("@flue/runtime", () => ({ getRun: vi.fn() }));

vi.mock("../.flue/lib/github.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../.flue/lib/github.js")>();
	return {
		...actual,
		readAppCreds: () => ({ appId: "1", installationId: "2", privateKey: "key" }),
		githubRateLimitGate: () => ({ getInstallationToken: async () => "token" }),
		fetchPullRequestState: async () => ({
			state: world.current.state,
			draft: world.current.draft,
			title: "Fix the cache",
			body: "",
			authorLogin: "contributor",
			headRef: "fix",
			headSha: world.current.head,
			baseRef: "main",
			baseSha: "base",
		}),
		fetchHeadChecks: async (_token: unknown, _owner: string, _repo: string, sha: string) =>
			world.current.checks.get(sha) ?? { total: 0, incomplete: 0 },
		fetchLastReviewedHead: async () => world.current.lastReviewed,
		hasReviewCheck: async (_token: unknown, _owner: string, _repo: string, sha: string) =>
			world.current.reviewChecks.has(sha),
		classifyRereviewMove: async (
			_token: unknown,
			_owner: string,
			_repo: string,
			_base: string,
			from: string,
			to: string,
		) => world.current.moves.get(`${from}..${to}`) ?? "substantive",
	};
});

vi.mock("../.flue/lib/review-watchdog.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../.flue/lib/review-watchdog.js")>();
	return {
		...actual,
		getReviewWatchdog: (_env: unknown, attemptId: string) => ({
			reserve: async () => {
				world.current.reserved.push(attemptId);
				world.current.active.add(attemptId);
				world.current.reviewChecks.add(attemptId.split("@")[1] ?? "");
				return { status: "acquired" };
			},
			isActive: async (id: string) => world.current.active.has(id),
		}),
	};
});

import { ReReviewScheduler } from "../.flue/cloudflare.js";
import { REREVIEW_CI_CEILING_MS, REREVIEW_POLL_MS } from "../.flue/lib/rereview.js";
import type { GatedPr } from "../.flue/lib/webhook.js";

class MemoryStorage {
	values = new Map<string, unknown>();
	alarm: number | undefined;

	async get<T>(key: string): Promise<T | undefined> {
		return this.values.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.values.set(key, value);
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}

	async setAlarm(alarm: number): Promise<void> {
		this.alarm = alarm;
	}

	async getAlarm(): Promise<number | null> {
		return this.alarm ?? null;
	}
}

const RUNNING = { total: 3, incomplete: 2 };
const DONE = { total: 3, incomplete: 0 };

function push(head: string): GatedPr {
	return {
		prNumber: 42,
		prTitle: "Fix the cache",
		prBody: "",
		headRef: "fix",
		headSha: head,
		baseRef: "main",
		baseSha: "base",
		owner: "emdash-cms",
		repo: "emdash",
	};
}

function setup() {
	world.current = {
		head: "A",
		state: "open",
		draft: false,
		checks: new Map(),
		lastReviewed: "R",
		reviewChecks: new Set(),
		moves: new Map(),
		active: new Set(),
		reserved: [],
	};
	const storage = new MemoryStorage();
	const scheduler = new ReReviewScheduler(
		{ storage } as unknown as DurableObjectState,
		{} as unknown as Env,
	);
	// Runs due alarms until `ms` has passed.
	const advance = async (ms: number) => {
		const until = Date.now() + ms;
		while (storage.alarm !== undefined && storage.alarm <= until) {
			vi.setSystemTime(storage.alarm);
			storage.alarm = undefined;
			await scheduler.alarm();
		}
		vi.setSystemTime(until);
	};
	const pushed = async (head: string) => {
		world.current.head = head;
		world.current.checks.set(head, RUNNING);
		await scheduler.schedule(push(head));
	};
	return { storage, scheduler, advance, pushed, reviewed: () => world.current.reserved };
}

const attempt = (head: string) => `rereview:emdash-cms/emdash#42@${head}`;

describe("ReReviewScheduler", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});

	it("reviews the head once its CI finishes and settles", async () => {
		const { advance, pushed, reviewed } = setup();
		await pushed("A");
		await advance(10 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([]);
		world.current.checks.set("A", DONE);
		await advance(3 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("A")]);
	});

	it("does not review a head superseded while its CI ran, and reviews the new head once", async () => {
		const { advance, pushed, reviewed } = setup();
		await pushed("A");
		await advance(REREVIEW_POLL_MS);
		await pushed("B");
		world.current.checks.set("A", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([]);
		world.current.checks.set("B", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B")]);
	});

	it("handles an older push's event arriving after the newer push finished CI", async () => {
		const { scheduler, advance, pushed, reviewed } = setup();
		await pushed("B");
		world.current.checks.set("A", DONE);
		world.current.checks.set("B", DONE);
		// A's delivery arrives late, after B is already the head.
		await scheduler.schedule(push("A"));
		await advance(10 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B")]);
		await scheduler.schedule(push("A"));
		await advance(10 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B")]);
	});

	it("reviews only the last of several quick pushes with overlapping CI", async () => {
		const { advance, pushed, reviewed } = setup();
		await pushed("A");
		await advance(REREVIEW_POLL_MS / 2);
		await pushed("B");
		world.current.checks.set("A", DONE);
		await advance(REREVIEW_POLL_MS);
		await pushed("C");
		world.current.checks.set("B", DONE);
		await advance(3 * REREVIEW_POLL_MS);
		world.current.checks.set("C", DONE);
		await advance(10 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("C")]);
	});

	it("waits for a running re-review instead of reviewing a push made during it", async () => {
		const { storage, advance, pushed, reviewed } = setup();
		await pushed("B");
		world.current.checks.set("B", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B")]);

		await pushed("C");
		world.current.checks.set("C", DONE);
		await advance(10 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B")]);

		// The running review's head-move loop reviewed C and posted against it.
		world.current.lastReviewed = "C";
		world.current.active.clear();
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B")]);
		const history = storage.values.get("history") as { admittedAt: number[] };
		expect(history.admittedAt).toHaveLength(1);
	});

	it("reviews the new head after a running re-review finishes without reaching it", async () => {
		const { advance, pushed, reviewed } = setup();
		await pushed("B");
		world.current.checks.set("B", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		await pushed("C");
		world.current.checks.set("C", DONE);
		world.current.lastReviewed = "B";
		world.current.active.clear();
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("B"), attempt("C")]);
	});

	it("reviews once when CI never finishes, at the ceiling", async () => {
		const { advance, pushed, reviewed } = setup();
		await pushed("A");
		await advance(REREVIEW_CI_CEILING_MS - REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([]);
		await advance(3 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("A")]);
		await advance(REREVIEW_CI_CEILING_MS);
		expect(reviewed()).toEqual([attempt("A")]);
	});

	it("reviews once despite duplicate and late deliveries for the same head", async () => {
		const { scheduler, advance, pushed, reviewed } = setup();
		await pushed("A");
		await scheduler.schedule(push("A"));
		world.current.checks.set("A", DONE);
		await scheduler.schedule(push("A"));
		await advance(5 * REREVIEW_POLL_MS);
		await scheduler.schedule(push("A"));
		world.current.active.clear();
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("A")]);
	});

	it("still reviews a substantive push when a format-only commit lands on top during CI", async () => {
		const { advance, pushed, reviewed } = setup();
		await pushed("A");
		await advance(REREVIEW_POLL_MS);
		// F only formats A, but the last reviewed head is R, before A.
		world.current.moves.set("A..F", "format_only");
		await pushed("F");
		world.current.checks.set("F", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([attempt("F")]);
	});

	it("skips a head whose only change since the last review is formatting or a base merge", async () => {
		const { advance, pushed, reviewed } = setup();
		world.current.moves.set("R..A", "format_only");
		world.current.moves.set("R..M", "base_merge_only");
		await pushed("A");
		world.current.checks.set("A", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		await pushed("M");
		world.current.checks.set("M", DONE);
		await advance(5 * REREVIEW_POLL_MS);
		expect(reviewed()).toEqual([]);
	});
});
