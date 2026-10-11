# dsh-market

[English](README.md) | 中文

**给 DeepSeek Harness 加上更新与重启按键，就在你本来就会看的那一排。**

插件界面顶部的两个按键：一个检查所有已安装插件是否有更新并一键全部更新，一个重启 DSH。

## 功能

- **一键检查更新** —— 打开时自动检查，也可以手动点。DSH profile 里每个已安装插件都会跟它真正的上游比对：registry 安装的比对 npm `latest` dist-tag，git 安装的比对远端 HEAD 提交。按键上的角标显示有多少个落后了。
- **一键全部更新，进度可见** —— 点一下就把所有可更新的插件装上。每个包各自报告状态（等待 / 进行中 / 完成 / 失败），一个包失败不会中断其余的：你拿到的是一份逐包报告，而不是一个笼统的报错。
- **如实说明检查了什么** —— 按键会区分「没有需要更新的」和「压根没检查成」。检查跑不起来时会明说，而不是悄悄告诉你已经是最新。
- **原地重启 DSH** —— 从终端启动的 `dsh web`，点一下就会用当初启动它的那条命令重新拉起，等新进程应答后自动刷新页面。
- **知道自己什么时候不该重启** —— 在进程守护（systemd / launchd / pm2）或 Electron 桌面外壳下，重启归别人管。此时按键会自己禁用并说明归谁管，而不是杀掉一个自己拉不回来的进程。
- **不依赖任何其他插件。** 整套东西是自包含的：它自己读你的 profile、自己驱动你的包管理器。

## 安装

```sh
dsh plugin --profile web add dsh-market
```

重启 `dsh web`，然后刷新页面并打开「插件」界面。两个按键会出现在该界面顶部，紧挨着它自己的刷新图标和「添加插件」按键。

<!-- INSTALL-TAIL -->

## 环境要求

- 带 Web 界面的 DSH，`0.2.0-rc.2` 或更新。
- Host 进程需要 Node.js `^22.19.0 || >=24.0.0`（即 DSH 自身要求的版本）。

## 工作原理

`dsh-market` 是一个包、两个半边，跟每个 DSH 插件一样：

**Host 半边**挂载进 DSH 的 host 进程，在 `/dsh-market/api/*` 下提供一小套 JSON 接口。它读取当前 profile —— 它的 `package.json`、它的 `dsh.profile.bundles`、以及已安装的 `node_modules` —— 来弄清装了什么、装的是哪个版本。更新检测就是跟包自己的上游做一次纯比较：npm registry 的 `latest` dist-tag，或者某个 git 远端公布的 HEAD。执行更新就是拿你自己的包管理器、在你自己的 profile 目录里跑一遍，**然后校验磁盘上的版本确实变了** —— 因为「包管理器退出码为 0 但什么都没变」恰恰是粗心更新器会当成成功报出去的那种失败。

**浏览器半边**注册进框架的浮层，再在「插件」界面挂载后把两个按键传送进该界面顶部。那一排由插件管理器自己渲染，没有给外部插件留插槽（只有 `plugins.detail.*`、`plugins.item`、`plugins.row.config` 与 `plugins.bundle.*`），因此定位依据是它挂在页面根节点上的 `data-plugin-panel` 标记加上它自己渲染的刷新控件，绝不依赖经过哈希的 CSS Module 类名。插件界面关闭时不绘制任何东西，界面其余部分与 DSH 原样保持一致。

当 host 做不了某件事时，两个按键都会退化成禁用态并给出说明 —— 绝不会给你一个能点、但点下去只会静默失败的按键。

## 安全

- 接口仅限本机回环、同源，并拒绝携带转发头的请求。它位于 DSH 自身的浏览器会话鉴权之后。
- 只会考虑已经列在你 DSH profile 里的包；更新器从不安装新东西。
- 更新用你自己 profile 的包管理器、按你自己 profile 的设置来跑，因此 pnpm 的构建脚本策略不受影响、也不会被改动。

## 已知限制

- **在进程守护或桌面应用下无法重启。** 这是刻意的：当生命周期归别人管时，进程无法可靠地拉起自己的替身。按键会说明这一点并指出归谁管。
- **检查更新需要网络**，用于访问 npm registry（git 安装的则访问 git 远端）。在受限网络下，检查会如实报告失败，而不是给出一个假的「已是最新」。
- **只提供向前更新。** 频道指回旧版本的包（例如某个预发布固定版转向了稳定版）会被报告出来，但不会被自动应用。

## HTTP 接口

浏览器端与宿主端通过 `/dsh-market/api/*` 下一组同源 JSON 接口通信。它不是公开 API，版本随包一起走。

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| `GET` | `/api/ping` | 存活探测，并返回每次进程启动都会变化的 `bootId` |
| `GET` | `/api/capabilities` | 这里哪些功能可用，以及重启归谁管 |
| `GET` | `/api/updates/summary` | 哪些已安装插件落后了（`?force=1` 跳过缓存） |
| `POST` | `/api/updates` | 更新单个包 |
| `POST` | `/api/updates/all` | 更新全部可更新插件 |
| `GET` | `/api/operations?id=` | 某次操作中每个包的进度 |
| `POST` | `/api/restart` | 在宿主自己掌握生命周期时重启宿主进程 |

读取类接口仅限本机回环且同源；写入类还要求 `Origin` 匹配。摘要里的 `checked` 是分母，代表真正检查过的插件数量——扫描失败会如实报错，绝不会返回 `checked: 0`。

**已知的别扭之处：** 在 `409` 拒绝响应体里，`error` 装的是给用户看的整句话，`reason` 装的是机器标记（例如 `desktop-host`）。这两个名字读起来是反的。它对齐的是宿主内部 `restartCapability` 的结构——在那个结构里，*名为* `reason` 的字段才是给用户看的字符串，而路由把它映射进了 `error`。因为内部自洽，所以选择记录下来而不是改名。客户端必须读 `error` 用于显示。

## 开发

```sh
pnpm install       # 这里不能用 npm install，原因见下
pnpm run build     # tsc + tsdown -> lib/ 与 client/
pnpm run verify    # 断言两个产物都可加载
pnpm test          # vitest
pnpm run check     # 以上全部
```

**请用 pnpm，不要用 npm。** 在本仓库执行 `npm install` 会直接报
`Cannot read properties of null (reading 'edgesOut')` 而中止。触发点是
`vitest@4.x`：在 npm 10.9.8 下，即使只把 `vitest` 作为唯一依赖也能复现；换成
`vitest@3.x` 就正常；在 pnpm 11 下从不出现。本包本身没有任何 npm 专有内容——
只要依赖装好了，上面这些命令用任何包管理器都能跑，`npm run <script>` 也一样。
只有「安装依赖」这一步必须用 pnpm。

把本地构建装进 profile 的方法见 [docs/INSTALL.md](docs/INSTALL.md)。

## 许可证

MIT
