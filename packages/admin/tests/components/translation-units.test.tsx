import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { screen } from "@testing-library/react";
import type * as React from "react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: React.ComponentProps<"a"> & { to: string }) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
	};
});

import { InsecurePasskeyContextMessage } from "../../src/components/auth/PasskeyContextMessage.js";
import { MarketplaceInstallMessage } from "../../src/components/PluginManager.js";
import { DomainRemovalMessage } from "../../src/components/settings/AllowedDomainsSettings.js";
import { SignupRoleMessage, VerificationSentMessage } from "../../src/components/SignupPage.js";
import { TaxonomyNotFoundMessage } from "../../src/components/TaxonomyManager.js";
import {
	WordPressExporterMessage,
	WordPressExportStep,
} from "../../src/components/WordPressImport.js";
import { render } from "../utils/render.js";

const jaMessages = {
	[msg`Passkeys require a <0>secure context</0>: use <1>HTTPS</1>, or open the admin at <2>http://localhost</2> (with your dev port). Plain <3>http://</3> on a custom hostname is not treated as secure, even on loopback.`
		.id!]:
		"パスキーには<0>セキュアコンテキスト</0>が必要です。<1>HTTPS</1>を使用するか、<2>http://localhost</2>（開発用ポートを含む）で管理画面を開いてください。カスタムホスト名の<3>http://</3>は、ループバックでも安全な接続として扱われません。",
	[msg`Browse the <0>marketplace</0> to install plugins, or add them to your astro.config.mjs.`
		.id!]:
		"<0>マーケットプレイス</0>からプラグインをインストールするか、astro.config.mjsに追加してください。",
	[msg`Users from <0>{domain}</0> will no longer be able to sign up without an invite. Existing users are not affected.`
		.id!]:
		"<0>{domain}</0>のユーザーは招待なしで登録できなくなります。既存のユーザーには影響しません。",
	[msg`For the best import experience, install the <0>EmDash Exporter</0> plugin on your WordPress site.`
		.id!]:
		"より完全にインポートするには、WordPressサイトに<0>EmDash Exporter</0>プラグインをインストールしてください。",
	[msg`2. Go to <0>Tools → Export</0>`.id!]: "2. <0>ツール → エクスポート</0>を開きます。",
	[msg`We've sent a verification link to <0>{email}</0>`.id!]:
		"<0>{email}</0>に確認リンクを送信しました。",
	[msg`You'll be signing up as <0>{roleName}</0>`.id!]: "<0>{roleName}</0>として登録します。",
	[msg`Taxonomy not found: {taxonomyName}`.id!]: "{taxonomyName}が見つかりません。",
};

beforeAll(() => {
	i18n.loadAndActivate({ locale: "ja", messages: jaMessages });
});

afterAll(() => {
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("complete translation units", () => {
	it("allows passkey guidance to reorder emphasized values", async () => {
		await render(
			<p data-testid="passkey-guidance">
				<InsecurePasskeyContextMessage />
			</p>,
		);

		expect(screen.getByTestId("passkey-guidance").textContent).toBe(
			"パスキーにはセキュアコンテキストが必要です。HTTPSを使用するか、http://localhost（開発用ポートを含む）で管理画面を開いてください。カスタムホスト名のhttp://は、ループバックでも安全な接続として扱われません。",
		);
	});

	it("allows links and dynamic values to move before their surrounding text", async () => {
		await render(
			<p data-testid="marketplace-guidance">
				<MarketplaceInstallMessage />
			</p>,
		);
		expect(screen.getByRole("link", { name: "マーケットプレイス" })).toBeTruthy();
		expect(screen.getByTestId("marketplace-guidance").textContent).toBe(
			"マーケットプレイスからプラグインをインストールするか、astro.config.mjsに追加してください。",
		);

		await render(
			<p data-testid="domain-removal">
				<DomainRemovalMessage domain="example.com" />
			</p>,
		);
		expect(screen.getByTestId("domain-removal").textContent).toBe(
			"example.comのユーザーは招待なしで登録できなくなります。既存のユーザーには影響しません。",
		);
	});

	it("keeps WordPress instructions in complete reorderable sentences", async () => {
		await render(
			<p data-testid="exporter-guidance">
				<WordPressExporterMessage />
			</p>,
		);
		expect(screen.getByTestId("exporter-guidance").textContent).toBe(
			"より完全にインポートするには、WordPressサイトにEmDash Exporterプラグインをインストールしてください。",
		);

		await render(
			<p data-testid="export-step">
				<WordPressExportStep />
			</p>,
		);
		expect(screen.getByTestId("export-step").textContent).toBe(
			"2. ツール → エクスポートを開きます。",
		);
	});

	it("allows signup values and taxonomy names to precede their translated text", async () => {
		await render(
			<p data-testid="verification-sent">
				<VerificationSentMessage email="user@example.com" />
			</p>,
		);
		expect(screen.getByTestId("verification-sent").textContent).toBe(
			"user@example.comに確認リンクを送信しました。",
		);

		await render(
			<p data-testid="signup-role">
				<SignupRoleMessage roleName="編集者" />
			</p>,
		);
		expect(screen.getByTestId("signup-role").textContent).toBe("編集者として登録します。");

		await render(
			<p data-testid="taxonomy-not-found">
				<TaxonomyNotFoundMessage taxonomyName="タグ" />
			</p>,
		);
		expect(screen.getByTestId("taxonomy-not-found").textContent).toBe("タグが見つかりません。");
	});
});
