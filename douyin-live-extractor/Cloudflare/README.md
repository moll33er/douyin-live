# Douyin Live Extractor (Cloudflare Pages版)

这是一个为 **Cloudflare Pages** 优化的抖音直播流提取工具。将原先基于 Node.js/Express 的后端彻底重构成了 Cloudflare Pages Functions（边缘函数），前端界面仍保持原样，实现零成本托管、全球边缘网络加速。

## 改造功能点

1. **移除 Express**：将 `/api/login` 和 `/api/live` 路由迁移至 Cloudflare 约定的 `functions/api/login.js` 和 `functions/api/live.js`。
2. **轻量依赖**：移除了原生的 `crypto` 和相对重量级的 `jsonwebtoken`，引入专门为 Edge Runtime 设计的标准 JWT 库 `jose`。
3. **原生 Fetch**：不再使用 `axios`，利用 Cloudflare 边缘环境原生的 `fetch` 接口来请求抖音页面。
4. **无状态 Secrets**：原有的文件系统 (`fs`) 和动态生成的 Secret 已被移除，改为通过 Cloudflare 的**环境变量和 Secrets** 进行更规范的管理。

## 部署步骤

您可以非常方便地将此 `Cloudflare` 文件夹部署到 Cloudflare Pages 上：

### 1. 准备代码仓库
请确保本 `Cloudflare` 目录的内容已经推送到您的 GitHub 或 GitLab 仓库。

> **注意**：如果该目录不是代码仓库的根目录，请在 Cloudflare Pages 配置时将 **Root directory (根目录)** 指定为 `Cloudflare`。

### 2. 在 Cloudflare 面板部署
1. 登录 Cloudflare Dashboard。
2. 转到 **"Workers & Pages" -> "Overview"**，点击 **"Create application"**。
3. 选择 **"Pages"** 标签页，点击 **"Connect to Git"**。
4. 选择您的仓库，配置如下：
   * **Framework preset**: `None`
   * **Build command**: (留空)
   * **Build output directory**: `public`
   * **Root directory**: 如果您直接部署此文件夹在顶级，留空（`/`）。如果只是将 `Cloudflare` 文件夹推上去了，则填 `/Cloudflare`。

### 3. 配置环境变量 (Environment Variables)

由于边缘节点无法读取本地配置文件（且每次启动动态生成 Secret 会导致用户频繁掉线），所有的配置**必须通过环境变量注入**。

在 Cloudflare Pages 的项目设置中（**Settings -> Environment variables**），**添加以下三个变量** (Production 和 Preview 都需要)：

* `USERNAME` (您的登录账号，默认如果未设置会回退为 `admin`)
* `PASSWORD` (您的登录密码，默认如果未设置会回退为 `password123`)
* `JWT_SECRET` (用于加密 Token 的专属密钥，您可以生成一段复杂的随机字符串填入)

> 💡 *加了环境变量后，建议重新触发一次 Deploy，让包含最新环境变量的 Worker 运行。*

### 4. 访问测试
访问分配给您的 `*.pages.dev` 域名，登录刚才设置的账密即可请求提取信息！
