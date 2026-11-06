import { expect, onTestFinished, vi } from "vitest";

/** The points of a motion a test reads it at, as shares of the way through its own duration. */
const ALONG = [0.25, 0.5, 0.75];

const isLive = (animation: Animation) => animation.playState !== "idle";

export interface HeldAnimations {
	/** The animations started since the hold began, held where they start until `release`. */
	readonly held: readonly Animation[];
	/** Waits for one held animation still in play, and returns those that are. */
	started: () => Promise<Animation[]>;
	/** Lets the held animations run on from where they were sought, and stops holding new ones. */
	release: () => void;
}

/**
 * Holds each animation a script starts on an element `match` accepts at its start, until the test
 * seeks it or lets it go. Reading a motion at chosen points of its own clock, rather than on
 * whichever frames the machine paints, keeps a test of how it moves independent of frame rate.
 */
export function holdAnimations(match: (target: Element) => boolean): HeldAnimations {
	const held: Animation[] = [];
	const animate = Element.prototype.animate;
	const spy = vi
		.spyOn(Element.prototype, "animate")
		.mockImplementation(function (this: Element, keyframes, options) {
			const animation = animate.call(this, keyframes, options);
			if (match(this)) {
				// Unlike a pause, a zero rate survives the script playing the animation itself.
				animation.playbackRate = 0;
				held.push(animation);
			}
			return animation;
		});
	let holding = true;
	const release = () => {
		if (!holding) return;
		holding = false;
		spy.mockRestore();
		for (const animation of held) if (animation.playbackRate === 0) animation.playbackRate = 1;
	};
	onTestFinished(release);
	return {
		held,
		async started() {
			await expect
				.poll(() => held.some(isLive), { timeout: 2000, message: "an animation to start" })
				.toBe(true);
			return held.filter(isLive);
		},
		release,
	};
}

/**
 * Seeks `animations` to each of `shares` of the way through their own durations, all together,
 * and returns what `read` gives at each.
 */
export function readAlong<T>(
	animations: readonly Animation[],
	read: () => T,
	shares: readonly number[] = ALONG,
): T[] {
	const live = animations.filter(isLive);
	expect(live.length, "animations to read along").toBeGreaterThan(0);
	return shares.map((share) => {
		for (const animation of live) {
			animation.currentTime = share * Number(animation.effect!.getComputedTiming().endTime);
		}
		return read();
	});
}

/** Expects `values` to go step by step from `from` toward `to`, each strictly between the two. */
export function expectGlide(values: readonly number[], from: number, to: number) {
	const path = [from, ...values, to];
	const message = path.map((value) => value.toFixed(2)).join(" -> ");
	const direction = Math.sign(to - from);
	expect(direction, message).not.toBe(0);
	for (let index = 1; index < path.length; index++) {
		expect((path[index]! - path[index - 1]!) * direction, message).toBeGreaterThan(0);
	}
}

/** Waits until nothing on the page animates. */
export async function untilStill() {
	await expect
		.poll(() => document.getAnimations().filter((a) => a.playState === "running").length)
		.toBe(0);
}

/**
 * Reads `read` before `trigger`, along the motion `trigger` starts on elements `match` accepts, and
 * once it has run its course and everything is still.
 */
export async function readMotion(
	match: (target: Element) => boolean,
	read: () => number,
	trigger: () => unknown,
): Promise<{ from: number; along: number[]; to: number }> {
	const from = read();
	const motion = holdAnimations(match);
	await trigger();
	const started = await motion.started();
	const along = readAlong(started, read);
	motion.release();
	// A script may hold an animation paused for a frame before it plays it.
	await Promise.all(started.map((animation) => animation.finished.catch(() => {})));
	await untilStill();
	return { from, along, to: read() };
}
