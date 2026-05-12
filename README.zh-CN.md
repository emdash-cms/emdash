# EmDash 免费维护版

[English](README.md) | [简体中文](README.zh-CN.md)

基于 [Astro](https://astro.build/) 与 [Cloudflare](https://www.cloudflare.com/) 的 TypeScript CMS。

> [!IMPORTANT]
> 当前仓库默认是**免费维护版**配置：`wrangler.jsonc` 已默认关闭 `worker_loaders`，这样 Cloudflare 免费计划可直接使用。

## 快速开始

```bash
npm create emdash@latest
```

或直接部署到 Cloudflare：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/emdash-cms/templates/tree/main/blog-cloudflare)

## 免费模式说明

| 模式 | 说明 | 是否需要付费计划 |
| --- | --- | --- |
| 免费维护版 | 关闭 `worker_loaders`，核心 CMS 正常可用（内容、管理后台、认证、媒体、主题等）。 | 否 |
| 沙箱插件模式 | 启用 Dynamic Worker Loader，插件在 Worker 隔离环境执行。 | 是 |

### Cloudflare 免费版默认 wrangler 配置

`worker_loaders` 默认是注释状态（按需启用）。

## 变更影响

日常建站和内容管理不受影响。受影响的是 Cloudflare 沙箱插件链路：当 `worker_loaders` 关闭时，沙箱插件与依赖它的 Marketplace 沙箱加载不会启用。

如果你仍需要插件能力，可选两种方式：

1. 使用 `plugins: []` 以内进程方式加载你自己的受信任插件（非沙箱）。
2. 升级 Cloudflare 计划并开启 `worker_loaders` + `sandboxRunner`，恢复沙箱插件。

## 可选：开启付费沙箱插件

在 `wrangler.jsonc` 里取消注释：

```jsonc
"worker_loaders": [
	{
		"binding": "LOADER"
	}
]
```

并在 `astro.config.mjs` 配置 `sandboxRunner`（例如 `@emdash-cms/cloudflare/sandbox`）。

## 模板

EmDash 提供 Blog / Marketing / Portfolio / Starter 模板。

## 开发

```bash
git clone https://github.com/emdash-cms/emdash.git && cd emdash
pnpm install
pnpm build
```

运行 demo（Node.js + SQLite，不需要 Cloudflare 账号）：

```bash
pnpm --filter emdash-demo seed
pnpm --filter emdash-demo dev
```

后台地址：[http://localhost:4321/\_emdash/admin](http://localhost:4321/_emdash/admin)

```bash
pnpm test
pnpm typecheck
pnpm lint:quick
pnpm format
```

文档：[https://docs.emdashcms.com/](https://docs.emdashcms.com/)  
贡献指南：[CONTRIBUTING.md](CONTRIBUTING.md)
