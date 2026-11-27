# 会话垃圾箱

[github.com/DokeDev/dsh-session-trash-bin](https://github.com/DokeDev/dsh-session-trash-bin)

给 DeepSeek Harness 加一个会话垃圾箱：删除会话不再直接粉碎，而是先把会话目录移入
`sessions-trash`，侧栏行立即消失；随后可以在应用内的「会话垃圾箱」里**恢复**、**彻底删除单条**，
或者**清空垃圾箱**。

本项目基于 [TuWeiZhi/dsh-session-delete](https://github.com/TuWeiZhi/dsh-session-delete)
（MIT）修改：原版只负责移入 `sessions-trash`，这里补上了垃圾箱列表、恢复和彻底删除。
保持原版的 **0 依赖、无构建**：只用 `node:fs`、`node:path`、`node:os`。

## 安装

1. 克隆本仓库，或下载 ZIP：

   ```sh
   git clone https://github.com/DokeDev/dsh-session-trash-bin.git
   ```

2. 打开左侧 **插件**。
3. 点击 **添加插件**，输入克隆下来的 `dsh-session-trash-bin` 目录的绝对路径。
4. 如果提示是否立即启用，选择 **立即启用**。Host 半侧只在启动时导入，可能需要重启 DSH 或
   在插件页切换一次开关；浏览器半侧在下次刷新页面时加载。
5. 确认出现并启用了 **会话垃圾箱** 这一行。

本包没有发布到 npm，请从本地目录安装。

如果已经安装了原版 `@tuweizhi/dsh-session-delete`，请先停用它：否则两个插件都会出现删除
菜单，并且共用同一个 `sessions-trash` 文件夹。

## 使用

### 删除会话

会话行 → **“…”**（或右键）→ **删除会话** → 确认 **移入垃圾箱**。

- 侧栏行立即消失，不需要刷新页面。
- 如果删的是当前打开的会话，主视图会回到空白状态。
- 成功提示里带 **恢复** 操作，可以直接把刚删的会话恢复。
- 如果还有运行中的工作（当前回合、子代理、后台任务、自动化任务），会先停止并 detach，
  再移动目录。

### 会话垃圾箱

会话行 → **“…”** → **会话垃圾箱…**：

- 列出所有已删除会话：标题、删除时间、大小、ID；
- **恢复**：把目录移回原来的项目目录，并尽量恢复工作区归属、归档/置顶状态；
- **彻底删除**：删除单条垃圾箱记录（点两次确认）；
- **清空垃圾箱**：二次确认后删除全部垃圾箱内容；
- **刷新**：重新读取列表。

恢复出来的是冷会话；操作完成后应用会刷新会话列表。

## 删除与保留的范围

普通删除会把整个会话目录（所有 `.jsonl.zstd` 版本和 `session.lock`）移动到：

```text
<DSH_HOME>/sessions-trash/<时间戳>-<随机后缀>__<sessionId>/
<DSH_HOME>/sessions-trash/<时间戳>-<随机后缀>__<sessionId>.json
```

同名 `.json` sidecar 保存原项目目录、标题、删除时间、大小，以及工作区/归档/置顶状态，
供恢复使用。

彻底删除会同时删掉目录和 sidecar；**清空垃圾箱** 会删掉整个 `sessions-trash`。

不会删除：

- **子代理会话**：它们是独立会话；本插件不做级联删除。父会话被删除后，子代理会话仍留在
  磁盘上（侧栏中不显示）。
- **附件**：按内容寻址，可能被多个会话共享。
- **对话在项目目录里创建的文件**：插件只动 sessions 根目录和 `sessions-trash` 下的会话状态。

## 垃圾箱细节

- 垃圾箱就是一个普通文件夹，不是 macOS 废纸篓，也不是 DSH 自带功能。
- 每条记录相互独立；删除一条不会影响其他记录。
- 原版插件留下的旧条目没有 sidecar，会显示为 **旧条目**：可以彻底删除，但不能自动恢复；
  需要手工把目录搬回 sessions 根目录。
- 没有按时间自动清理；要释放空间请手动清空。
- 路径只从校验过的 session ID 或垃圾箱条目名推导，绝不接受客户端传来的文件路径；
  破坏性 POST 只允许本机回环地址且要求同源 `Origin`。

## 要求与限制

- DSH `>= 0.2.1-alpha.1`（在 0.2.2 系列上验证；原版针对 0.2.2-rc.1 验证），Node.js
  `>= 22.19.0`。
- Host 半侧使用 DSH 内部的 `sessions`、`agents`、`workspaceRegistry`、
  `sessionPersistence`、`webServer` 服务；每个调用都做了 feature-detect，但 DSH
  升级若重命名这些内部接口，插件可能退化。
- Host 在 `/dsh-session-trash-bin` 下注册 HTTP 路由，仅限本机回环。
- 对话框是纯 DOM，挂在 `document.body` 上，因此位于侧栏抽屉之上；配色跟随页面明暗背景。
- 内置中文和英文，其他 DSH 语言回退到英文。
- 停用插件只会移除菜单和路由；已经移入 `sessions-trash` 的会话不会自动恢复。

## 卸载

在 **插件** 中移除本 bundle。`sessions-trash` 不会被自动删除；不需要时请手工清理。

## 许可证

MIT。基于 TuWeiZhi/dsh-session-delete，见 `LICENSE`。
