# 对话删除（@fufu1437/dsh-delete-chat）

一个 DeepSeek Harness（DSH）插件：**永久删除一个对话**及其在本机的全部数据副本。

侧边栏每个会话行的 `…` 菜单里会多出一项「删除对话…」。点击后立即弹出确认框，确认后删除在**后台执行**，窗口随即关闭；完成后该对话从侧边栏消失。确认前不做任何统计或预扫描。

> English: [README.md](README.md)

## 删除哪些数据

一个对话在磁盘上留下的东西比多数人以为的多。本插件逐项清除：

| # | 数据 | 位置 | 说明 |
|---|---|---|---|
| 1 | 会话日志目录 | `~/.dsh/sessions/<项目键>/<会话 id>/` | 含**所有**格式代（`session.v3.jsonl.zstd`、`session.v4.jsonl.zstd` …）与写入租约 `session.lock` |
| 2 | 投影缓存记录 | `~/.dsh/storages/session_projcache/sessions/<id>.json` | 缓存的**标题**与**首条提示词文本**，以及 `.json.bak.*` 备份 |
| 3 | 旧版反馈旁车记录 | `~/.dsh/storages/message_feedback.json` | 当前服务不再读取的旧格式，可能含用户留言文本 |
| 4 | 工作区索引 | `~/.dsh/storages/workspace.json` | 会话的归属顺序、归档集合、置顶集合（经由工作区注册表的公开 API 写入） |
| 5 | 溢写的工具输出 | `<spill 根>/session-<sha256(id) 前 12 位>/` | 每个本机 spill 根（含 `$TMPDIR/dsh-spill-*`） |
| 6 | 附件 | `~/.dsh/attachments/v1/{objects,files,file-objects,request-images}` | **仅**在证实没有任何其他存活会话引用后才删除 |
| 7 | 子代理会话 | 同 1–5 | 该对话派生的全部持久化子代理会话（递归） |
| 8 | DeepSeek 上传缓存 | `~/.dsh/llm-deepseek/files-v3.json` | 被删附件的记录，以及其 `variantId` 对应的请求图像派生缓存 |

删除后，插件会向所有已连接客户端广播 `api-session/removed`，侧边栏条目立即消失，无需等下一次列表刷新。

## 安全模型

删除是不可逆的破坏性操作，因此实现遵循两条硬约束：

**1. 正在生成回复的对话不动，已打开但空闲的对话会先抹除再删。** Host 会为本次进程内打开过的每个对话持有一个 Agent 和日志写入句柄（DSH 没有公开的「释放会话」API），所以在写入方仍持有句柄时单纯 `rm` 只会把内容留在已 unlink 的 inode 里——那是假删除。因此：

- 对话正在生成回复（有 turn 在跑）→ 拒绝 `409 session-running`，请先停止它；
- 对话已在本进程打开但空闲 → 先拒绝 `409 session-live`（带 `forceable: true`），界面弹出**第二次确认**；确认后按「**原位覆写（写 0）→ 解链**」执行，即使写入方仍持有 fd，磁盘上的内容也已被真正抹掉；
- 子代理会话仍存活 → 同理 `409 descendant-live` + 二次确认。

代价是这类「活着的」对话**要到 Harness 重启后**才会从会话列表彻底消失；如果它在界面上仍打开并继续发送消息，有可能生成一份新的（空）日志。第二次确认框会把这些说清楚。

**2. 无法证明安全就不删。** 附件对象按内容寻址、可能在多个会话间共享，因此只有当**所有存活会话**的日志都被扫描过、且都没有引用该 id 时才会删除。扫描是流式解压（不构建事件数组），受会话数上限与解压字节预算约束；一旦超限或遇到无法读取的日志，附件会**保留**并在结果里给出警告。

其他工程约束：

- 会话 id 经与 JSONL 后端逐字节一致的 `encodeSegment` 转义后才用于路径，`../`、绝对路径、NUL 均无法逃出根目录；
- 只使用 `node:` 内置模块，**不依赖任何 `@deepseek-ai/*` 私有包**，因此可以作为普通 npm 包发布；
- 两个 HTTP 路由都先经过组合的 `connection.requestRejection` 信任围栏（Host/Origin 校验 + 浏览器会话 cookie），未认证请求得到 401/403。

## 安装

需要 pnpm（DSH profile 本身即由 pnpm 管理）。

从 npm（发布后）：

```bash
dsh plugin install @fufu1437/dsh-delete-chat
```

或在本机开发目录里：

```bash
pnpm add @fufu1437/dsh-delete-chat     # 或作为本地 link 依赖
dsh plugin install /绝对路径/到/dsh-delete-chat
```

使用 Harness 内的插件管理工具同样可以：以包目录（或 `.tgz`、npm 包名）为 target 调用 `install_bundle`。

安装后，**Host 半部的新代码需要重启 Harness 才会生效**：本 profile 的 `hmr` 行配置为 `root: []`（不监听插件模块根），已加载的模块代会被进程缓存。客户端半部随页面加载即生效。

## 使用

1. 在左侧栏把鼠标移到某个对话行，点 `…`；
2. 选择「删除对话…」；
3. 确认框只有标题、不可撤销提示和「取消 / 永久删除」两个按钮（不显示条目数或体积）；
4. 点「永久删除」后窗口立即关闭，删除在后台继续；侧边栏条目在 Host 广播移除后消失；
5. 若该对话仍在当前 Harness 进程中打开，会再弹一次带警告的确认（「仍然删除」）——说明内容会被原位覆写、且要重启 Harness 才会从列表消失；
6. 其他失败（例如对话正在生成回复）会在右下角出现一张提示卡说明原因，直到你关闭它。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: fufu-delete-chat
  name: '@fufu1437/dsh-delete-chat'
  config:
    dshHome: /home/me/.dsh
    deleteAttachments: true
    deleteDescendants: true
    scanLimit: 500
    scanByteLimit: 2147483648
```

| 字段 | 默认 | 含义 |
|---|---|---|
| `dshHome` | `$DSH_HOME` → `~/.dsh` | Harness home；其余根目录都从它派生 |
| `sessionsRoot` | `<dshHome>/sessions` | 会话日志根 |
| `storagesRoot` | `<dshHome>/storages` | storage-json 根 |
| `attachmentsRoot` | `<dshHome>/attachments/v1` | 附件根 |
| `llmFilesRoot` | `<dshHome>/llm-deepseek` | DeepSeek 上传缓存根 |
| `spillRoots` | 自动发现 `$TMPDIR/dsh-spill-*` | 溢写根列表 |
| `deleteAttachments` | `true` | 是否执行附件证明并删除无人引用的附件 |
| `deleteDescendants` | `true` | 是否连带删除子代理会话 |
| `scanLimit` | `500` | 附件证明最多扫描多少个会话日志 |
| `scanByteLimit` | `2 GiB` | 附件证明最多解压多少字节 |

## 验证

```bash
pnpm test          # 固定件自测：68 项断言，不触碰真实数据
pnpm run check     # 两个半部的语法检查
```

`scripts/selftest.mjs` 会搭一份完整的临时 harness home（会话日志、投影缓存、工作区索引、旧反馈旁车、spill、附件、上传缓存），脚本化的 Host 上下文驱动 plan/execute，并断言**删除后留下了什么**：

- 各产物类别被清除、其他会话的数据完好；
- 存活/运行中/子代理存活的会话被拒绝；
- 被其他会话引用的附件保留，独享附件删除；
- 扫描被截断或日志无法解压时附件保留并给出警告；
- 恶意会话 id 无法逃出根目录；
- **原位覆写确实生效**：测试保留一个指向日志的打开句柄（模拟存活的写入方），删除后从该句柄读到的全是 0，证明内容不是「只解链」。

`.tmp/e2e.mjs` 是针对**运行中 Host** 的端到端脚本（不随包发布）：它伪造页面使用的浏览器会话 cookie，在真实 DSH home 里创建一个合成会话（日志 + 投影缓存 + spill + 附件），经真实信任围栏调用 delete，断言产物消失，并验证活动会话被 409 拒绝、`/inspect` 路由已不存在。需要写权限，且运行后自行清理。

`.tmp/proof-scan.mjs` 只读地对真实语料跑一次完整附件证明（本机 187 个会话日志约 1.5 秒完成）。

## 已知限制

- **正在生成回复的对话无法删除**，需要先停止它（有意保留的唯一硬拒绝）。
- **已打开过的对话可以删，但会留下一个「僵尸」会话对象**，直到 Harness 重启（DSH 无公开的会话释放 API）：磁盘内容已原位覆写并解链，它仍可能出现在会话列表里，或在界面上继续发消息时生成一份新的空日志。
- **已导出的遥测无法召回**：`session-telemetry-otel` 可能在 `FEEDBACK_ONLY` 模式下已把日志前缀发给远端；本插件只能删除本机数据。
- **派生缓存的边界**：请求图像缓存按 `variantId` 删除需要 `files-v3.json` 存在对应记录；其他未在日志中留下附件引用的派生副本不在覆盖范围内。
- 旧版 `message_feedback.json` 是旁车数据，当前服务不读它；本插件直接读改写它。
- `workspace.json` 优先经由工作区注册表 API 修改；该服务不存在时才直接改文件（此时不会有人在内存里覆盖）。
- 本机 spill 默认根是临时目录，若 Harness 曾用其它 `root` 配置且目录已被清理，则无残留可删。

## 发布

```bash
pnpm run check && pnpm test
pnpm publish --access public     # 作用域包需要 public
```

`prepublishOnly` 会先跑语法检查与自测。

## 许可

MIT
