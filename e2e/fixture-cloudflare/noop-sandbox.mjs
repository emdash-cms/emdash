/**
 * Noop sandbox runner for e2e tests.
 *
 * The marketplace admin pages need an available sandbox in the manifest to
 * render browse/detail UI. The sandbox runner is only used at install time.
 * This stub satisfies the availability gate without executing plugin code.
 */
import { NoopSandboxRunner } from "emdash";

class MarketplaceTestSandboxRunner extends NoopSandboxRunner {
	isAvailable() {
		return true;
	}
}

export function createSandboxRunner() {
	return new MarketplaceTestSandboxRunner();
}
