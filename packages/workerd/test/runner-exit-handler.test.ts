/**
 * Exit Handler Tests
 *
 * Regression coverage for a race in WorkerdSandboxRunner.restart(): the
 * exit handler used to capture `this` and unconditionally mutate
 * `this.workerdProcess` / `this.healthy` whenever it fired. A late exit
 * from a previously-spawned workerd could therefore null out the handle
 * of a freshly-spawned workerd and mark it unhealthy.
 *
 * The fix is an identity guard inside `makeWorkerdExitHandler`: if
 * `host.workerdProcess` no longer points at the proc the handler was
 * bound to, the handler is a stale survivor from a prior workerd and
 * must short-circuit.
 */

import type { ChildProcess } from "node:child_process";

import { describe, it, expect } from "vitest";

import { makeWorkerdExitHandler } from "../src/sandbox/runner.js";
import type { ExitHandlerHost } from "../src/sandbox/runner.js";

interface FakeHost extends ExitHandlerHost {
	scheduleRestartCalls: number;
}

function makeHost(overrides: Partial<ExitHandlerHost> = {}): FakeHost {
	const host: FakeHost = {
		workerdProcess: null,
		healthy: false,
		shuttingDown: false,
		intentionalStop: false,
		scheduleRestartCalls: 0,
		scheduleRestart() {
			host.scheduleRestartCalls++;
		},
		...overrides,
	};
	return host;
}

// The handler only ever uses `proc` as an identity reference (===
// comparison against host.workerdProcess), so any object will do.
function fakeProc(label: string): ChildProcess {
	return { __label: label } as unknown as ChildProcess;
}

describe("makeWorkerdExitHandler", () => {
	it("is a no-op when host has moved on to a newer workerd", () => {
		const procA = fakeProc("A");
		const procB = fakeProc("B");
		const host = makeHost({ workerdProcess: procB, healthy: true });

		makeWorkerdExitHandler(host, procA)(1, null);

		// procB is still installed and untouched -- the stale handler
		// must not null it out or mark it unhealthy.
		expect(host.workerdProcess).toBe(procB);
		expect(host.healthy).toBe(true);
		expect(host.scheduleRestartCalls).toBe(0);
	});

	it("nulls out the handle and schedules a restart on crash exit", () => {
		const procA = fakeProc("A");
		const host = makeHost({ workerdProcess: procA, healthy: true });

		makeWorkerdExitHandler(host, procA)(1, null);

		expect(host.workerdProcess).toBeNull();
		expect(host.healthy).toBe(false);
		expect(host.scheduleRestartCalls).toBe(1);
	});

	it("clears intentionalStop and skips restart for intentional stops", () => {
		const procA = fakeProc("A");
		const host = makeHost({
			workerdProcess: procA,
			healthy: true,
			intentionalStop: true,
		});

		makeWorkerdExitHandler(host, procA)(0, null);

		// Handle/health still get cleared (the process is gone), but
		// the intentional-stop flag must be consumed and no restart
		// must be scheduled -- otherwise every plugin reload would
		// trigger a phantom crash-restart cycle.
		expect(host.workerdProcess).toBeNull();
		expect(host.healthy).toBe(false);
		expect(host.intentionalStop).toBe(false);
		expect(host.scheduleRestartCalls).toBe(0);
	});

	it("skips restart while the runner is shutting down", () => {
		const procA = fakeProc("A");
		const host = makeHost({
			workerdProcess: procA,
			healthy: true,
			shuttingDown: true,
		});

		makeWorkerdExitHandler(host, procA)(1, "SIGTERM");

		expect(host.workerdProcess).toBeNull();
		expect(host.healthy).toBe(false);
		expect(host.scheduleRestartCalls).toBe(0);
	});

	it("schedules a restart when killed by a signal even if code is null", () => {
		const procA = fakeProc("A");
		const host = makeHost({ workerdProcess: procA, healthy: true });

		makeWorkerdExitHandler(host, procA)(null, "SIGKILL");

		expect(host.workerdProcess).toBeNull();
		expect(host.healthy).toBe(false);
		expect(host.scheduleRestartCalls).toBe(1);
	});

	it("does not schedule a restart on a clean exit (code 0, no signal)", () => {
		const procA = fakeProc("A");
		const host = makeHost({ workerdProcess: procA, healthy: true });

		makeWorkerdExitHandler(host, procA)(0, null);

		expect(host.workerdProcess).toBeNull();
		expect(host.healthy).toBe(false);
		expect(host.scheduleRestartCalls).toBe(0);
	});
});
