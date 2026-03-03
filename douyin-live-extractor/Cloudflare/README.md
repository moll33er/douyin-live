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

### ⚠️ 重要提示：不能在网页端直接拖拽上传！
Cloudflare 官方限制：**通过网页端直接拖拽上传文件夹（Direct Upload）不支持识别 `functions/` (边缘函数)！**
如果您直接拖拽上传文件夹，会提示“不支持 Pages Functions”，并且导致后端的 API 接口 404 失效。

必须通过以下**两种方式之一**进行部署：

### 部署方式一（推荐）：通过 Git 仓库部署
1. 登录 Cloudflare Dashboard。
2. 转到 **"Workers & Pages" -> "Overview"**，点击 **"Create application"**。
3. 选择 **"Pages"** 标签页，点击 **"Connect to Git"**。
4. 选择您的仓库，配置如下：
   * **Framework preset (框架预设)**: `None`
   * **Build command (构建命令)**: `npm install` （**必填**，用于下载依赖如 `jose` 库以支持边缘函数运行，否则部署会报 `Could not resolve "jose"` 的错误）
   * **Build output directory (构建输出目录)**: `public`
   * **Root directory (根目录)**: 填写代码仓库中此目录所在的相对路径。例如，如果直接将 `Cloudflare` 文件夹推上了仓库，则填 `/Cloudflare`。

### 部署方式二（进阶）：本地使用 Wrangler 命令行部署
如果您不想使用 Git 仓库，必须在本地使用 Cloudflare 官方的命令行工具进行发布：
1. 确保已安装 **Node.js** 和 npm。
2. 在 `Cloudflare` 目录下打开终端，执行：
   ```bash
   npx wrangler pages deploy . --project-name douyin-live-extractor
   ```
   > ⚠️ **注意修改点**：这里是 `deploy .`（代表当前 `Cloudflare` 整个目录），**不要**写成 `deploy public`，否则 Cloudflare 会把 `public` 当根目录而无视掉旁边的 `functions` 文件夹，这就是导致 404 的原因！
3. 部署过程中会提示：
   * `Select the folder you want to deploy`: 确认是当前的 `Cloudflare` 目录。
   * 然后直接选 `yes` 或按回车。
4. 根据提示登录 Cloudflare 账号，并在终端选定您的 Cloudflare 账户。
5. 部署成功后终端会返回一个 `*.pages.dev` 域名。

### 3. 配置环境变量 (Environment Variables)

由于边缘节点无法读取本地配置文件（且每次启动动态生成 Secret 会导致用户频繁掉线），所有的配置**必须通过环境变量注入**。

在 Cloudflare Pages 的项目设置中（**Settings -> Environment variables**），**添加以下三个变量** (Production 和 Preview 都需要)：

* `USERNAME` (您的登录账号，默认如果未设置会回退为 `admin`)
* `PASSWORD` (您的登录密码，默认如果未设置会回退为 `password123`)
* `JWT_SECRET` (用于加密 Token 的专属密钥，您可以生成一段复杂的随机字符串填入)

> 💡 *加了环境变量后，建议重新触发一次 Deploy，让包含最新环境变量的 Worker 运行。*

### 4. 访问测试
访问分配给您的 `*.pages.dev` 域名，登录刚才设置的账密即可请求提取信息！
