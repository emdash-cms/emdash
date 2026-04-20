import { describe, it, expect } from "vitest";

import {
	buildEmDashCsp,
	generateNonce,
	injectNonceAttributes,
} from "../../../src/astro/middleware/csp.js";

// ---------------------------------------------------------------------------
// generateNonce
// ---------------------------------------------------------------------------

describe("generateNonce", () => {
	it("returns a 24-character string", () => {
		const nonce = generateNonce();
		expect(nonce).toHaveLength(24);
	});

	it("only contains base64url-safe characters (no +/=)", () => {
		const nonce = generateNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
	});

	it("produces unique values across calls", () => {
		const nonces: string[] = [];
		for (let i = 0; i < 50; i++) nonces.push(generateNonce());
		expect(new Set(nonces).size).toBe(50);
	});
});

// ---------------------------------------------------------------------------
// injectNonceAttributes
// ---------------------------------------------------------------------------

describe("injectNonceAttributes", () => {
	const nonce = "abc123nonce";

	it("adds nonce to <script> tags without one", () => {
		const html = '<script>console.log("hi")</script>';
		expect(injectNonceAttributes(html, nonce)).toBe(
			`<script nonce="${nonce}">console.log("hi")</script>`,
		);
	});

	it("adds nonce to <script> tags with attributes", () => {
		const html = '<script src="app.js" defer></script>';
		expect(injectNonceAttributes(html, nonce)).toBe(
			`<script nonce="${nonce}" src="app.js" defer></script>`,
		);
	});

	it("adds nonce to <style> tags without one", () => {
		const html = "<style>body{color:red}</style>";
		expect(injectNonceAttributes(html, nonce)).toBe(
			`<style nonce="${nonce}">body{color:red}</style>`,
		);
	});

	it("does not add nonce to <script> tags that already have one", () => {
		const html = `<script nonce="existing">code</script>`;
		expect(injectNonceAttributes(html, nonce)).toBe(`<script nonce="existing">code</script>`);
	});

	it("does not add nonce to <style> tags that already have one", () => {
		const html = `<style nonce="existing">body{}</style>`;
		expect(injectNonceAttributes(html, nonce)).toBe(`<style nonce="existing">body{}</style>`);
	});

	it("handles multiple tags in a single document", () => {
		const html = "<script>a()</script><style>b{}</style><script src='c.js'></script>";
		const result = injectNonceAttributes(html, nonce);
		expect(result).toBe(
			`<script nonce="${nonce}">a()</script>` +
				`<style nonce="${nonce}">b{}</style>` +
				`<script nonce="${nonce}" src='c.js'></script>`,
		);
	});

	it("handles mixed tagged and untagged content", () => {
		const html = "<p>text</p><script>a()</script><p>more</p>";
		const result = injectNonceAttributes(html, nonce);
		expect(result).toContain(`nonce="${nonce}"`);
		expect(result).toContain("<p>text</p>");
	});
});

// ---------------------------------------------------------------------------
// buildEmDashCsp
// ---------------------------------------------------------------------------

describe("buildEmDashCsp", () => {
	const nonce = "testnonce123";

	describe("production mode (dev=false)", () => {
		it("includes nonce in script-src", () => {
			const csp = buildEmDashCsp(nonce, false);
			const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
			expect(scriptSrc).toBe(`script-src 'self' 'nonce-${nonce}'`);
		});

		it("includes nonce in style-src", () => {
			const csp = buildEmDashCsp(nonce, false);
			const styleSrc = csp.split("; ").find((d) => d.startsWith("style-src"));
			expect(styleSrc).toBe(`style-src 'self' 'nonce-${nonce}'`);
		});

		it("does not include unsafe-inline", () => {
			const csp = buildEmDashCsp(nonce, false);
			expect(csp).not.toContain("'unsafe-inline'");
		});
	});

	describe("dev mode (dev=true)", () => {
		it("includes nonce and unsafe-inline in script-src", () => {
			const csp = buildEmDashCsp(nonce, true);
			const scriptSrc = csp.split("; ").find((d) => d.startsWith("script-src"));
			expect(scriptSrc).toBe(`script-src 'self' 'nonce-${nonce}' 'unsafe-inline'`);
		});

		it("includes nonce and unsafe-inline in style-src", () => {
			const csp = buildEmDashCsp(nonce, true);
			const styleSrc = csp.split("; ").find((d) => d.startsWith("style-src"));
			expect(styleSrc).toBe(`style-src 'self' 'nonce-${nonce}' 'unsafe-inline'`);
		});
	});

	it("includes https: in img-src to allow external images", () => {
		const csp = buildEmDashCsp(nonce, false);
		const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"));
		expect(imgSrc).toContain("https:");
	});

	it("still includes self, data:, and blob: in img-src", () => {
		const csp = buildEmDashCsp(nonce, false);
		const imgSrc = csp.split("; ").find((d) => d.startsWith("img-src"));
		expect(imgSrc).toContain("'self'");
		expect(imgSrc).toContain("data:");
		expect(imgSrc).toContain("blob:");
	});

	it("keeps connect-src restricted to self", () => {
		const csp = buildEmDashCsp(nonce, false);
		const connectSrc = csp.split("; ").find((d) => d.startsWith("connect-src"));
		expect(connectSrc).toBe("connect-src 'self'");
	});

	it("blocks framing with frame-ancestors none", () => {
		const csp = buildEmDashCsp(nonce, false);
		expect(csp).toContain("frame-ancestors 'none'");
	});

	it("blocks plugins with object-src none", () => {
		const csp = buildEmDashCsp(nonce, false);
		expect(csp).toContain("object-src 'none'");
	});

	it("restricts base-uri to self", () => {
		const csp = buildEmDashCsp(nonce, false);
		expect(csp).toContain("base-uri 'self'");
	});

	it("restricts form-action to self", () => {
		const csp = buildEmDashCsp(nonce, false);
		expect(csp).toContain("form-action 'self'");
	});
});
