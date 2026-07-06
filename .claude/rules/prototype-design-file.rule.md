# coder-loop 原型图：位置、打开与观察

GUI 设计事实源：**项目根目录 `gui-prototype.pen`**（Pencil 加密设计文件，路径 `/Users/mouriya/Ext/code/coder-loop/gui-prototype.pen`）。agent 只做只读观察，不生成、不覆盖、不改名。

`mcp__pencil__get_editor_state` 报的 `filePath` 可能是过时缓存路径——**永远显式传本 rule 钉的绝对路径，别信 MCP editor state 的 active 路径**。

## 打开：只有 CLI headless 是"打开"

```
pencil interactive --in gui-prototype.pen --out <scratch>.pen
```

- shell 命令：`get_editor_state` / `batch_get` / `get_screenshot` / `batch_design` / `save()` / `exit()`。
- **`--out` 必填；严禁指向 `gui-prototype.pen`**——`save()` 会写到 `--out`，指错就覆盖原文件。scratch 落点用 `~/agent-work/pencil-*/` 或本地 `/tmp/`。
- **一次一条 tool call**。pipe 多条会撞 `ERR_USE_AFTER_CLOSE`，别塞 `exit()` 也别拼多行。要连做就多次调 CLI（每次重启进程、重加载 .pen）。
- shell 返回 `{ "image": "<base64 PNG>", "mimeType": "image/png" }`；PNG 解码：`grep -o '"image": "[^"]*"' | sed 's/"image": "//;s/"$//' | base64 -d > x.png`。

## 观察：MCP 是只读观察面（无 save）

`mcp__pencil__*` 工具没有 save 能力——`batch_design` 只改当前 editor session，不落盘。只用于观察。

- 连的很可能是操作员 Pencil desktop app 的 live 会话（比磁盘 checked-in 版本新，节点树也不同）；对**磁盘 checked-in 版本**做精确观察请用 CLI headless。
- 对磁盘文件截图务必显式传 `filePath`，别依赖 "editor active file"：
  ```
  mcp__pencil__get_screenshot({
    filePath: "/Users/mouriya/Ext/code/coder-loop/gui-prototype.pen",
    nodeId: "document"
  })
  ```
- MCP editor 报告的 nodeId 未必存在于磁盘副本；跨路径复用 nodeId 前先在目标路径侧核实。

## 禁忌

- `.pen` 加密，禁止 `Read` / `Grep` 直接读，只通过 pencil MCP / CLI 访问。
- 禁止用 `pencil --in ... --out ... --prompt ...`（generation 模式）生成或修改本文件，除非操作员明确要求。
- `pencil-cli-model` 全局规则（`--model claude-opus-4-7`）**不适用于** `pencil interactive`——interactive 是纯工具面 shell，无 `--model` 参数。

Why：原型图是 v3 设计的锚点，"MCP 打开"是术语错位——MCP 只能观察，没有 save，且它看到的可能是 desktop app 的 live 会话而非磁盘副本；真正把文件加载进可编辑/可 save 会话的只有 CLI headless。混淆两者会让 agent 以为 "MCP 里 batch_design 改了就生效"，或把 `--out` 指错覆盖设计事实源。
