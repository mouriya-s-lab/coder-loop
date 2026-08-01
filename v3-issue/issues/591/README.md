# #591 feat(engine): preset 级具名 gate 点——绑定解析与未绑定语义

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:51Z  | updated: 2026-07-17T20:41:06Z
- closed: 2026-07-17T20:41:06Z  | state_reason: `not_planned`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/591
- comments: 2  | timeline events: 16

---

## Body

## 必须先读的关联 issue

#543（RFC: v3 生命周期 hook）与 #555（#547 树，具名 gate 点声明位）。继承条款逐字快照：

> "preset 级是抽象 gate 点：preset 只声明「此处需要一道命名 gate」（保持 preset 可分发、不含本机脚本路径），具体脚本由全局/chain 层绑定到该名字；声明语法归 RFC-2 的 DSL（见接口假设）。" — #543 声明位与合成语义

> "7. **具名 gate 点声明位**（#543 需求）：preset 声明「此处需要一道命名 gate」（名字 + required/optional 标志），脚本绑定归全局/chain 层——语法归本 RFC，语义归 #543。" — #547 核心设计·DSL 演进面

> "#543 的「preset 级抽象 gate 点」child 消费本声明位：运行期在声明点查找绑定、执行 gate、按 `advance | hold | reopen` 契约判定——全部归 #543，本 child 不实现。" — #555 使用场景

> "**语义零实现**：本 child 不实现 gate 执行、绑定查找、判定处理——引擎运行路径对 gate 点声明的消费为零（声明存在不改变任何调度行为），语义整体归 #543 children。" — #555 预期结果

## 目标

preset 声明的具名 gate 点获得执行语义：全局/chain 层绑定声明（gate 名 → 脚本 + 超时 + onFailure）、运行期在声明点解析绑定并执行 gate、未绑定语义（optional 空过；required 在实例创建边界拒绝；已存在实例恢复时缺绑定则显式 hold）。

## 使用场景

- preset 作者声明 `gate "code-audit" required`（#555 语法）；operator 在 chain 级把 `code-audit` 绑到本机脚本。preset 保持可分发（不含本机路径），同一 preset 在不同机器绑不同脚本。
- operator 部署前从编译产物看到该 preset 需要哪些 gate（#555 暴露面），据此配齐绑定；漏配 required gate 在 chain/item 实例创建时结构化拒绝；既有 pinned 实例重启时绑定丢失则显式 hold 并点名 gate。

## 上下文

repo `mouriya-s-lab/coder-loop`，基线 main（2026-07-02 核实；行号实施前自行 grep 核对）。

- 声明消费源：#555 的 gate 点声明（名字 + required/optional + `GateDecisionPoint` ADT 引用）经编译产物暴露；本 child 直接按 point variant 与 host identity 映射到 #590/#592 的执行点，不从 phase/tree 文本位置猜测。
- 绑定存储：#586（声明模型） 的全局/chain 声明载体——绑定条目是其声明 schema 的扩展 variant（穷尽 union 位已留）。
- 执行框架：#590（决策点闭集） 的统一评估路径；具名 gate 解析出绑定后作为 preset 层成员进同一合成（顺序 全局→chain→preset→item）。

## 问题

#555 只做声明位与产物暴露（语义零实现，见继承快照）；绑定声明、运行期查找、未绑定语义全部悬空——RFC 关闭验证行 5 的 preset 层份额与开放问题「preset 抽象 gate 点未被任何层绑定时的语义」无处成立。

## 预期结果

性质表述：

1. **绑定声明**：全局/chain 层可声明 gate 名 → 脚本绑定（含超时/onFailure），arktype 边界 parse，进#586（声明模型） 的生效视图（preset 层成员，合成顺序位置 = preset）。
2. **解析三态穷尽**：装载时每个 preset 声明的 gate 点解析为穷尽三态——已绑定（执行如普通 gate，走统一评估路径零特例）| 未绑定 optional（空过，跳过事件可见）| 未绑定 required（新实例创建拒绝；既有实例恢复 hold）；无 default 兜底。
3. **可分发性质**：preset 本体（toml + 模板）中不存在本机脚本路径的通道——绑定只在全局/chain 层。
4. **执行同路径**：绑定后的 gate 执行与其他层 gate 走同一协议/onFailure/合成实现，无 preset 层特例代码。

### 绑定解析裁决

- preset compile 不依赖某台机器的绑定，因此 required 未绑定不在 compile 期伪报。chain/item 实例创建时解析 effective binding：required 缺失则结构化拒绝创建并点名 gate；optional 缺失空过且发 skip 事件。已存在的 pinned 实例在 daemon 重启时若 required binding 丢失，进入可观察 hold，不回退到 optional、不换脚本。
- 同名绑定采用配置覆盖语义：chain binding 覆盖 global binding；只有一个 effective script 作为 preset 层 gate 执行，不把两份绑定都跑。global/chain 自己声明的普通 hooks 仍按四层合成各自执行，与“为 preset named gate 提供绑定”是两种不同角色。生效视图必须同时显示 selected binding 与 shadowed source，便于审计。

## 不应残留

- 本 child 范围内：preset 内出现本机脚本路径的任何通道；绑定解析绕过生效视图的第二套读取路径；preset 层 gate 的执行特例分支。
- 本 issue 范围之外不应改动：#555 的声明语法与编译产物 shape（本 child 的 PR 出现声明语法变更即越界）；决策点评估机制本体（归闭集 child）；判定契约文本。

## 约束

- 代码红线（操作员裁决 2026-06-12，全仓统一）：必须全链路 ADT，禁止任何类型退化。不引入 `any`/匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转。违反红线 = changes requested，无例外。
- 「语法归 #547（#555 承载），语义归 #543」是已裁分工——本 child 拥有语义半边。
- 与 #534 audit 树排序默认（v3 总控整合裁定，2026-07-02）：#535/#536/#538 默认先合、本 child 其后 rebase；偏离需在本 issue 说明理由。

## 本 issue 的验证边界

- **验证层级**：真实 daemon + 隔离 loop-data + 确定性 runner 的专用进程级 integration。
- **本 issue 必须证明**：fixture 直接进入本 issue 新增的运行态与转移，观察 SQLite/status/events/进程或资源生命周期的前后值；只跑旧线性 preset而没有进入新状态不算通过。
- **不在本 issue 内执行**：不负责连接全部 v3 子系统，也不运行 bundled preset compatibility real E2E。跨 issue 场景归 #684；真实 GitHub preset 不回归归 #685。
- **现有 GitHub real E2E**：本 issue 不运行 `bun scripts/real-e2e.ts`；该 compatibility 验证只由 #685 在冻结发布候选 SHA 上执行。
## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 绑定执行（RFC 行 5 preset 层份额） | fixture preset 声明具名 gate 点，chain 层绑定 fixture 脚本（hold→advance），真跑 | local | 声明点按 preset 层合成顺序执行该 gate；hold/advance 行为与其他层 gate 一致 |
| function | optional 未绑定空过 | optional gate 点零绑定，真跑 | local | 调度照常推进；跳过事件可见 |
| function | required 未绑定 | required gate 零绑定分别创建新实例、恢复既有 pinned 实例 | local | 新实例结构化拒绝创建；既有实例 hold；两者都点名 gate，无 optional fallback |
| function | 层间遮蔽/回落 | 同名 binding 同时置于 global 与 chain 层 | local | 只执行 chain binding；生效视图显示 selected chain + shadowed global；普通 global/chain hooks 不受影响 |
| function | 可分发性质 | grep fixture preset 全文 | local | preset 本体无本机脚本路径 |
| integration | 四层全景合成（RFC 行 5 完整化） | 全局 + chain + preset（绑定）+ item 同挂点各声明一个 gate，其一 hold，真跑 | local | 按 全局→chain→preset→item 顺序执行（脚本记录执行序）；任一 hold 即整点 hold——RFC 行 5 全语义在此行成立 |
| environment | 类型链完好 | `bun run typecheck && bun test` | local | 全绿 |

## 依赖关系

- Depends on: #555（总控简报边 3：声明位与产物暴露）、#586（声明模型）（绑定载体与生效视图）、#590（决策点闭集）（统一评估路径与锚定承载点）、#605（既有实例恢复时必须按 pinned definition 解析 gate 声明）。
- 协调边：#555 的「gate 点锚定位置」决策项（其裁决先于本 child 的执行点映射定形）；#592（join script）（锚定裁为树节点时的执行通道）。


---

## Comments (2)

### comment #4866576460 by `RiriAgent` — 2026-07-02T14:01:35Z


## 架构切片

1. **系统定位**：hook 声明面的 preset 层间接绑定级——「接口与实现分离」在声明模型上的实例：preset 声明需求（名字），operator 声明供给（绑定），装载期做需求-供给匹配。
2. **全局坐标**：preset 声明域（可分发工件，#555 编译产物）× operator 绑定域（本机全局/chain 声明）→ 装载期匹配 → 生效视图 preset 层成员。两个输入域各自已有边界 parse，本 child 拥有匹配语义与三态结果类型。
3. **类型↔值不漂移**：防值漂移——gate 名在 preset 与绑定两侧是同一标识符空间，匹配结果三态穷尽，不存在「绑了但没被看见」的静默中间态。防类型泄露——本机路径不得进入 preset 域（可分发性质）。
4. **消除的错误类别**：「preset 需要的 gate 漏配且无人知晓」不可表达（三态 + required 裁决语义 + 编译产物暴露）；「preset 携带本机路径失去可分发性」不可表达。

## log/观测义务

- optional 未绑定的空过跳事件（lifecycle/diagnostic 按裁决定）——「为什么这个 gate 点没拦」可从事件流回答。
- required 未绑定按裁决形态产生 load 错误或运行期拒绝事件，点名 gate 名。
- 绑定执行本身沿统一 `hook.*` 事件契约（#590（决策点闭集） 已铺）。



### comment #5007298942 by `RiriAgent` — 2026-07-17T20:41:06Z

重新拆分后由 #713 承接。旧 issue 无关联 PR，关闭。


---

## Timeline (16)

- 2026-07-02T12:02:52Z `assigned` @RiriAgent
- 2026-07-02T14:00:50Z `cross-referenced` @RiriAgentsrc=586
- 2026-07-02T14:00:54Z `cross-referenced` @RiriAgentsrc=589
- 2026-07-02T14:00:56Z `cross-referenced` @RiriAgentsrc=590
- 2026-07-02T14:00:59Z `cross-referenced` @RiriAgentsrc=593
- 2026-07-02T14:01:21Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:01:35Z `commented` @RiriAgent
- 2026-07-02T14:01:48Z `cross-referenced` @RiriAgentsrc=543
- 2026-07-02T14:02:21Z `cross-referenced` @RiriAgentsrc=555
- 2026-07-17T20:36:17Z `cross-referenced` @RiriAgentsrc=710
- 2026-07-17T20:36:21Z `cross-referenced` @RiriAgentsrc=712
- 2026-07-17T20:36:24Z `cross-referenced` @RiriAgentsrc=713
- 2026-07-17T20:36:28Z `cross-referenced` @RiriAgentsrc=715
- 2026-07-17T20:37:25Z `cross-referenced` @RiriAgentsrc=740
- 2026-07-17T20:41:06Z `commented` @RiriAgent
- 2026-07-17T20:41:07Z `closed` @RiriAgentcommit=None