# RFC #545 R7 P-02：外部 GUI / hook 现有 consumer 边界

固定基线：`/Users/mouriya/Ext/code/coder-loop` `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本报告只证明现有 consumer 与部署接线；未读取生产数据库、生产 `hooks.json` 或其他生产数据，未修改任何被查工程。

## A. 摘要

1. **可访问范围内没有 coder-loop context 的仓外源码 consumer。** 没有工程命中 `context_entries`、`listContextEntries`、coder-loop `context.*`、`db.sqlite`、`daemon.sock`、`CODER_LOOP_DATA_DIR` 或 `preset compile`。因此当前没有已建立的仓外 context SQLite 直读、socket read response shape、compiled JSON/HTTP context shape 依赖。
2. **“权威 GUI 工程”当前并不存在。** coder-loop 的权威拆分文档仍把 GUI 技术栈与“monorepo 还是独立 repo”列为未决调查项（`v3/rfc-split.md:89-101`）；本仓只有 UX/业务文档和 `.pen` 原型。根 `package.json` 只有 Bun/TypeScript、arktype、cmd-ts 与单个 CLI bin，没有前端/server package（`package.json:1-21`）。这些是设计/原型线索，不是运行 consumer。
3. **现有 coder-loop hook 只是声明/展示数据，不是脚本执行 consumer，更不读取 context。** daemon 从 loop-data `hooks.json` 装载声明并合并 global/chain/preset/item effective view（`src/runtime-paths.ts:4-19,117-130`；`src/hook-declarations.ts:29-58,82-100,138-168`；`src/daemon.ts:1215-1244`）。集成测试明确证明调度期间脚本不执行（`tests/integration/daemon/hooks.integration.ts:5-18,39-59`）。源码符号穷尽结果中 `declaration.script` 只被解析/序列化，没有 spawn/exec 调用。因此不存在“现有 hook 经 CLI 普通读取面读取共享 context”的实现 consumer。
4. **已有相邻工程不是本 consumer。** `github-hapi-agent-router` 明确把 GitHub issue webhook 转发给 Mac-local HAPI daemon（`README.md:1-15,25-45`），不是 coder-loop GUI/hook read；`moat-webgui` 与 `moat-hook-adapter` 的 README 分别归属 moat Gateway 与 Agent runtime hook（各自 `README.md:1-11`），不是 coder-loop 工程。HAPI 中的 `context.append_loop_event` 是 Kimi wire event 名，不是 coder-loop context（`hapi/cli/src/kimi/utils/kimiWireScanner.ts:60-78`）。
5. **结论边界：** L034 的未知已在“可访问的源码与 IaC checkout”范围内收敛为零 consumer；生产主机上的手工脚本、未 checkout 私有仓、未登记部署仍未知。本任务禁止访问生产数据，不能把源码/IaC 零命中外推为所有机器绝对不存在。

## B. 查找范围与权威性

### B1. 权威位置的建立

| 线索 | 事实 | 权威判断 |
|---|---|---|
| coder-loop RFC 拆分 | GUI 仓库归属仍是调查项；数据候选是 socket、events、status、SQLite，context 展示只登记接缝 | `v3/rfc-split.md:89-101` 是本 RFC 系列对 GUI 工程状态的权威说明；它没有给出外部 GUI repo |
| coder-loop GUI 文档 | GUI 被定义为控制面、不是 DB browser；definition 面未来消费 `preset compile --json`；timeline 未来消费 typed envelope | `v3/gui-ux-design.md:1-9,274-317,338-342` 是设计合同，不是源码 consumer |
| coder-loop 业务文档 | context entries 被列为同一执行事实的一种投影；写动作原样转发 operator RPC | `v3/gui-business-flows.md:83-85,216-235` 是未来消费语义，不证明当前接线 |
| coder-loop manifest | 单一 CLI bin，无 Web/frontend/server 依赖 | `package.json:1-21` 反证本 checkout 没有 GUI implementation package |
| RFC-6 相邻工程指针 | 唯一明确外部路径是 `github-hapi-agent-router`，且被描述为 GitHub→HAPI 的 ingress 参考 | `v3/rfc-split.md:103-113`；它不属于 RFC-5 GUI 或 RFC-4 hook consumer |
| hook runtime | `hooks.json` 路径、声明 parser、effective view 和“不执行”测试均在 coder-loop 本仓 | 这是现有 hook 声明面的权威源码；没有另一个 hook execution 工程指针 |

### B2. 可访问 checkout

逐个固定当前本地 SHA 并只读搜索：

| checkout | SHA | 与本证明的关系 |
|---|---|---|
| `coder-loop` | `699842eba2eefc242d19f8fa9232bc1d9d5c3bdd` | 主基线、GUI 设计与 hook 声明权威源 |
| `hapi` | `90f45977a6d26647e3668b61b02d404d2c036b5c` | RFC 文档点名的相邻执行/会话系统 |
| `github-hapi-agent-router` | `14de4e426ed3a327715aec4ca7ee069216bed8ea` | RFC 文档唯一点名的外部 router 参考 |
| `github-hapi-iac-daemon` | `dba2ccfbb403bb67131fd45e14a652e4bb858f89` | router/IaC 相邻 daemon |
| `moat-webgui` | `95b31febfec4a7ee976e8b9d9309d78edc92a64d` | 名称相似的 GUI 假线索，README 证明归 moat |
| `moat-hook-adapter` | `8dfa77016a6deee8979dbe23c579ad2531dffb68` | 名称相似的 hook 假线索，README 证明归 moat |
| `homelab-tf` | `4310017cc2e8d07aa2ad27283ceb7082df4347ca` | 可访问的部署/IaC 接线源 |
| `pve-vctcn` | `6702ecac6ea759d5488f886539e9fc0f8ec938ad` | 可访问的部署/IaC 接线源 |
| `Ext/app/coder-loop` | `423c021bb25e3e3cee139eabbf63ee5f0e5d2e2c` | 本机运行仓；是 coder-loop 自身副本，不是仓外 consumer |

对上述仓执行精确搜索：

```text
context_entries | listContextEntries | context.append | context append |
preset compile | compiledtask | daemon.sock | db.sqlite |
CODER_LOOP_DATA_DIR | coder-loop
```

排除 `.git`、`node_modules`、lock、dist。外部候选仅有 22 个命中：HAPI Kimi 的同名 wire event、HAPI 测试 fixture 的 `/code/coder-loop` 路径，以及 pve-vctcn 对 e2e fixture/agent 登录场景的文字引用；没有任何 coder-loop 数据读取或 mount/env 接线。完整原始清单在 `/tmp/rfc545-p02/external-exact.txt`。

## C. Consumer 矩阵

| 对象 | 类别 | 当前数据源 / boundary | 身份 | context 相关？ | 结论与证据 |
|---|---|---|---|---|---|
| coder-loop GUI UX / business docs | 原型/文档线索 | 未来 typed daemon capability、operator RPC、typed event envelope、`preset compile --json`；context entries 仅被列为 projection | 未来 operator | 仅设计上相关 | **非源码 consumer。** `v3/gui-ux-design.md:274-317,338-342`；`v3/gui-business-flows.md:83-85,216-235` |
| `gui-prototype.pen` | 原型 | 静态设计文件 | 无运行身份 | 视觉线索，不构成读取 | **非部署、非 consumer。** 权威规则仅称其“GUI 设计事实源”，且要求只读观察：`.claude/rules/prototype-design-file.rule.md:3-26` |
| coder-loop global/chain/preset/item hook declarations | 本仓源码数据 consumer | `hooks.json` + SQLite metadata → parser → effective view / JSON projection | daemon/operator control-plane declaration | **否**；不读 `context_entries` | **存在声明 consumer，不存在脚本执行 consumer。** `src/runtime-paths.ts:4-19,117-130`；`src/hook-declarations.ts:29-58,82-100,138-168`；`src/daemon.ts:1215-1244` |
| hook script runtime | 预期 future consumer | 当前没有 stdin/stdout execution boundary；没有 CLI/socket read call | 尚不存在 | 否 | **零实现。** 测试哨兵确认调度不执行脚本：`tests/integration/daemon/hooks.integration.ts:5-18,39-59` |
| `Ext/app/coder-loop` | 运行仓 / 部署副本 | 自身 `db.sqlite`、socket、events、CLI | coder-loop daemon/operator/agent | store 有 context；不是外部读取者 | **不是 GUI/hook 仓外 consumer。** 只是同一产品运行副本；本任务未读取其生产 DB/配置 |
| HAPI web/hub/CLI | 相邻源码 | 自有 API/session/wire protocol | HAPI user/session | 否 | **无 coder-loop read。** 精确搜索只命中 Kimi 自有 `context.append_loop_event`：`hapi/cli/src/kimi/utils/kimiWireScanner.ts:60-78` |
| `github-hapi-agent-router` | 相邻 router 源码 | GitHub webhook → NetBird → HAPI daemon | router/HAPI | 否 | **不是 coder-loop consumer。** `github-hapi-agent-router/README.md:1-15,25-45` |
| `github-hapi-iac-daemon` | 相邻 daemon 源码 | 无 coder-loop 精确命中 | 自有 daemon | 否 | **无 consumer / mount / env 证据。** `/tmp/rfc545-p02/external-exact.txt` 零命中 |
| `moat-webgui` | 名称相似的 GUI repo | moat WebGUI Gateway REST/WS/SSE | moat operator | 否 | **排除。** `moat-webgui/README.md:1-11` 明确设计事实源与部署归 moat |
| `moat-hook-adapter` | 名称相似的 hook repo | Agent runtime events → snapshot/OTel/notification | moat agent runtime | 否 | **排除。** `moat-hook-adapter/README.md:1-11` |
| `homelab-tf` / `pve-vctcn` | 部署接线 | 可访问 IaC 源 | infra | 否 | **没有 coder-loop GUI/hook service、DB/socket mount、context env/API 接线。** 精确搜索结果仅 pve-vctcn 的 e2e fixture与 agent 登录文字，不是读取 |

### C1. 各读取形态的现状判定

| 读取形态 | 可访问外部 consumer 数 | 判定 |
|---|---:|---|
| 直接打开 `db.sqlite` / 查询 `context_entries` | 0 | 未发现 |
| 调 coder-loop context socket read verb | 0 | read verb/response shape 本身尚不存在 |
| 调 coder-loop CLI context read | 0 | CLI 只有 append；没有外部 caller |
| 消费 context HTTP/REST/WS/SSE | 0 | coder-loop 没有该 API；相邻 moat API 不属于 coder-loop |
| 消费 compiled JSON 中的 context | 0 | GUI 文档只规定 future definition projection；没有实现 consumer |
| hook 脚本内部再调 operator CLI read | 0 | hook 脚本当前不执行，普通读取面也不存在 |
| 读取 events/status 并把它冒充 context | 0 | GUI 仅设计文档；无实现工程 |

## D. 未知与访问边界

1. **未读取生产数据。** 未打开 `~/.coder-loop/loop-data/db.sqlite`、生产 `hooks.json`、events 或 daemon socket；因此不枚举 live hook script 路径，也不声称生产机器没有手工脚本。
2. **未发现、也没有权威文档指向独立 coder-loop GUI checkout。** 权威文档仍把仓库归属列为未决（`v3/rfc-split.md:95-101`）。若存在未 checkout 私有 repo，本轮没有可验证路径；结论保持未知。
3. **IaC 零命中只覆盖两个本地权威 checkout 当前 SHA。** 未登记的 launchd、shell profile、个人脚本或其他机器配置不在可证明集合。
4. **`github-hapi-agent-router` 是 RFC-6 相邻 ingress，不是本证明要找的 RFC-5 GUI / RFC-4 hook consumer。** 它的零 coder-loop 命中不能被写成“未来 router 不会消费”，只能证明当前 SHA 不消费。
5. **GUI 文档所写 socket/events/SQLite“可用数据源”是设计调查事实，不是接线事实。** 尤其不能据此声称 GUI 已经直读 SQLite；当前没有 GUI implementation package。

## E. 证据索引

| 证据 | 位置 |
|---|---|
| RFC-4 hook 与 RFC-5 GUI 的现状、未决工程归属 | `v3/rfc-split.md:75-113` |
| GUI 不是 DB browser；future compile/event/capability contract | `v3/gui-ux-design.md:1-9,274-317,338-342` |
| context entries 仅为 future GUI causal projection；operator RPC 原样转发 | `v3/gui-business-flows.md:83-85,216-235` |
| 主仓没有 GUI/server package | `package.json:1-21` |
| runtime DB/hooks/socket 路径 | `src/runtime-paths.ts:4-19,117-130` |
| hook declaration ADT、parser、effective view、JSON projection | `src/hook-declarations.ts:29-58,82-100,138-168` |
| daemon 只装载并合并声明 | `src/daemon.ts:1215-1244` |
| hook 不执行的 runtime 集成证据 | `tests/integration/daemon/hooks.integration.ts:5-18,39-59` |
| router 实际边界是 GitHub→HAPI | `/Users/mouriya/Ext/code/github-hapi-agent-router/README.md:1-15,25-45` |
| moat GUI/hook 均非 coder-loop | `/Users/mouriya/Ext/code/moat-webgui/README.md:1-11`；`/Users/mouriya/Ext/code/moat-hook-adapter/README.md:1-11` |
| HAPI 同名 context 是 Kimi wire event | `/Users/mouriya/Ext/code/hapi/cli/src/kimi/utils/kimiWireScanner.ts:60-78` |
| 外部候选精确搜索完整结果 | `/tmp/rfc545-p02/external-exact.txt` |
| hook 脚本字段生产引用完整结果 | `/tmp/rfc545-p02/hook-symbols.txt` |
| 候选 checkout SHA 与抽样输出 | `/tmp/rfc545-p02/candidates.txt` |

**完整交付声明：** 已从本仓权威 RFC、GUI 文档、manifest、runtime path 与 hook 源码建立真实位置；已对可访问的 GUI/hook/router/HAPI/IaC/运行仓候选做只读 consumer 清单；已逐类核对 SQLite、socket、CLI、compiled JSON、HTTP/API、GUI 展示、hook 调用和 deployment mount/env；已区分源码 consumer、部署接线与原型/文档线索；所有无法覆盖的生产手工接线和未 checkout 私有工程均保留为未知。未修改代码、配置或 WORKFLOW，未创建 worktree/issue/PR，未访问生产数据，未提出 GUI/hook 方案。
