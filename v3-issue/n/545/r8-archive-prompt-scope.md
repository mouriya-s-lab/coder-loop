# RFC #545 R8 事实／合同档案：prompt scope 文档

固定基线：`main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`。本档案定义 D8/K4b 的唯一可观察合同；不改写 daemon 的授权权威，不设计并行结构、group membership、DSL、GUI 或 body 注入机制。

## A. 用户目标

每次 phase 都可能启动一个没有前轮记忆的 agent。声明 context capability 的 agent 必须能从 prompt 中得到 append/read 用法，并对本 run 可用的 `chain | item | group` scope 组成合法调用；它不应读取 credential、猜 stable key、依赖未定义的外部来源找地址，也不应在 prompt 中看到任何 entry body。

因此可观察目标不是展示某一组诊断字段，而是：**agent 读到文档后，能按最终 CLI boundary 对每个当前可用 scope 直接、无猜测地寻址。**

## B. 唯一合同

声明 context capability 的 phase，由 `toolRequirementsDoc` 注入 append/read 用法，并对本 run 的每个可用 scope 给出可执行寻址说明：

1. credential 自动推导的参数明确说明无需填写；
2. CLI 要求显式提交 stable key 时，提供当前合法值；
3. 当前没有合法 group 时，文档不得猜测、合成或 fallback 到其他 group；
4. 所有展示值都只用于寻址，daemon 仍以 credential 与 durable identity/lineage 独立验证 caller、chain 和 key；
5. 不展示 opaque credential；
6. scope 闭集仍是 `item | chain | group`，不增加 `run` scope；
7. 不注入 entry body、摘要、marker 或 sentinel。

值以内联示例、已有 placeholder、typed 字段或其他等价方式呈现属于接线选择，只要最终文档与 CLI 参数合同一致、可由该 run 直接执行，就不产生新的产品语义。

## C. 当前 append 的实际寻址需要

当前命令形态是：

`coder-loop context append <chain> --scope <chain|item|group> [--item <id> | --group <id>] (--body ... | --body-file ...)`

| scope | 当前 CLI 要求显式提交 | daemon/credential 负责 |
|---|---|---|
| `chain` | positional chain selector、`--scope chain`、body | 构造 agent author；以 bound chain 核对 selector |
| `item` | positional chain selector、`--scope item`、业务 item stable ID、body | 构造 agent author；核对 bound chain/item |
| `group` | positional chain selector、`--scope group`、group stable ID、body | 构造 agent author；未来按权威并行结构身份核验 membership |

CLI 会从 `CODER_LOOP_RUN_CRED` 自动附带 credential，但当前不会替调用方填 chain selector、item ID 或 group ID。因此，只给静态语法不足以完成当前 append：

- chain name 可复用已有 engine runtime binding `chainName`；
- item 业务 ID 可复用 preset 已声明的 `item.<idField>` binding；
- group stable ID 目前没有通用 runtime binding，只有权威并行结构 producer 真正提供且 daemon 能验证时才可进入文档；当前缺失时必须明确不可用，不能从 runtime ancestry 自行生成。

证据：`src/loop.ts@699842e:1943-1986,2526-2556`；`src/context-entry.ts@699842e:4-10,121-136`；`r7-d05-read-auth.md:17-19,61-84`。

## D. read 合同不得虚构尚不存在的 flag

固定基线没有 context read CLI、daemon command 或 response boundary，因此本档案不命名未来 subcommand、selector 或 flag。稳定要求只有：

- agent 查询受 credential 所属 chain 限定；operator 无 credential 时可选择 chain；
- 过滤闭集是 scope variant + stable key、author subject/phase、`after` cursor；
- `pageSize` 是每次请求显式正整数；
- 返回 `nextCursor | exhausted`。

最终 read boundary 落地后，`toolRequirementsDoc` 必须记录其真实命令形态。若某 scope 地址由 credential 自动确定，就明确说明该参数省略；若 boundary 要求 stable key，就提供该 run 当前合法值或明确该 scope 当前不可用。当前 phase 可作为 author filter 的一个可能值，但 author filter 不是 scope，也不能据此增加 run scope。

证据：`aggregate.md` D8/D10/D11；`r7-d05-read-auth.md:5-7,33-35,173-180`。

## E. 显式参数与自动推导的一致性

credential 权威绑定 author identity 与 agent 所属 chain。它允许 daemon 构造不可自报的 author、限制可见 chain、校验显式 selector/scope key；它不自动意味着 CLI 已省略这些参数。

文档与 boundary 必须遵守同一规则：

| 最终 boundary | 文档义务 |
|---|---|
| 参数由 credential/daemon 自动推导 | 明确说明无需填写及其作用范围，不重复要求 agent提交同一值 |
| 参数由 CLI 要求显式 stable key | 给出当前合法值或既有、确定的 runtime binding，使 agent 无需猜测 |
| 当前 run 没有该 scope | 明确不可用，不生成伪 key、不静默 fallback |

无论哪种 shape，prompt 值都不是 capability。复制其他 run 的地址不能取得权限；daemon 必须重新验证 credential、chain、item 与 group membership。

## F. 验收 oracle

实现 issue 确定最终 append/read boundary 后，必须用命令级验证证明：

1. 仅声明 context capability 的 phase 获得对应用法；未声明的 phase 不获得该文档。
2. 文档覆盖真实存在的 append/read 命令与参数，不引用未实现 flag。
3. 对每个本 run 可用 scope，agent 可按文档直接组成合法调用；显式 key 与自动推导规则不矛盾。
4. agent 不需要猜 item/group key；无合法 group 时不会获得合成或 fallback key。
5. body sentinel 在所有 phase prompt 中零命中；允许的寻址信息只能来自 runtime/doc binding，不能从 entry 内容复制。
6. raw socket/daemon 路径独立证明 caller、chain 与 key 的 credential confinement；CLI 预填或重写不能代替 server-side 验证。
7. 文档、`--help`、typed request/result 与实际命令保持一致。

## G. 未知与外部输入

- 当前没有公开 context read/query 路径、request/result schema 或 consumer；其具体语法必须等待实现事实，不能在本档案虚构。
- `toolRequirementsDoc`、context capability 与其 runtime binding 尚未实现；现有空 tools projection 不是可复用合同。
- group 地址只能来自并行结构层定义的真实容器身份；真实 `par` producer、branch credential 与 daemon consumer 尚无当前可运行路径。
- daemon restart 会丢失 active credential registry；durable lineage 可恢复不等于旧 credential 仍有效。
- operator socket trust boundary、CLI/daemon 命令清单漂移是独立工程问题，不由 prompt 文档替代。
- 已有 `chainName` 和 item binding 如何组合进最终文档属于呈现/接线问题；只要满足 B/F 节，不重新形成产品分叉。

## H. 证据索引

| 结论 | 权威证据 |
|---|---|
| scope 只有 item/chain/group；无 run scope | `../../../v3-issue/synthesized/SYNTH-545-context-shared-cli.md:36-41` |
| doc-binding 注入 CLI 用法 + 本 run scope 标识，不注入内容 | 同文件 `:57-59` |
| group 默认键可由运行态推导；显式路径仍须校验真实容器 | 同文件 `:205-218` |
| 是否需要具体运行时值取决于 credential/CLI 推导充分性 | 同文件 `:255-276` |
| 当前 append 要求 chain selector、scope variant、item/group key | `src/loop.ts@699842e:1943-1986`; `src/context-entry.ts@699842e:4-10,121-136` |
| credential 自动附带但 daemon 才是 author/chain authority | `src/loop.ts@699842e:2526-2556`; `r7-d05-read-auth.md:17-19,69-84` |
| 已有 `chainName` 与 item binding；无 group binding | `src/loop.ts@699842e:1221-1272,5778-5835,6007-6054` |
| read 尚不存在；不得假设具体 flag | `r7-d05-read-auth.md:5-7`; `r7-d06-group-lineage.md:105` |
| read 稳定过滤合同 | `aggregate.md:24-27` |
| K4b 有效性审计与唯一合同 | `r8-prompt-decision-validity-audit.md` |
