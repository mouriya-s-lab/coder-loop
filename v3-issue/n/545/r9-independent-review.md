# RFC #545 R9 独立复核

## A. Verdict

**PASS**

`aggregate.md` 与 `r9-expected-foundation.md` 已完成 no-legacy 收敛。前次复核指出的三类问题均已从当前正文消除，且修订没有引入新的产品需求、实现机制预裁或相互矛盾文本。R9 预期地基可以作为 R10 的需求侧输入。

## B. 逐项检查

### B1. aggregate no-legacy

| 检查项 | 结论 | 当前证据 |
|---|---|---|
| storage/write 完成性误标 | PASS | `aggregate.md:3` 已改为“现存资产与待修补供给”；`aggregate.md:158` 已改为“现存资产 / 待修补供给”。这与 `:35-42` 的偏离摘要、`:52-63` 的逐项状态一致。 |
| S45 伪标准 | PASS | 标准池止于 S44；`aggregate.md:122` 只让 S44 在冻结 SHA 复核真实路径 S23，没有第二条 group 完成口径。 |
| K1 伪选择 | PASS | `aggregate.md:86,122,188` 均要求真实 `par` producer、两个真实 branch credential 与双向写读；fixture 只证明局部主张。 |
| K4a 祖先 membership 伪选择 | PASS | `aggregate.md:133,191` 不再从 ancestry 推导 membership 集合或基数；RFC #545 只消费并行结构层未来给出的权威身份与归属结论。 |
| K4b 字段组合伪选择 | PASS | `aggregate.md:24,104,192` 只保留与最终 CLI boundary 一致的可执行寻址合同，没有 identity/handle 字段组合选项。 |
| 旧编号与互相否定文本 | PASS | 未见 S45、DEC-545-02/03、C0–C3 或最近/全部祖先候选作为当前合同。S01–S44、D1–D15、K1–K5 均在本文有当前定义。 |

### B2. F-01～F-10 分层与范围

| Foundation | 结论 | 复核要点 |
|---|---|---|
| F-01 Storage authority / lifecycle | PASS | 稳定条款、实然旁路、修补后 authority/lifecycle 保证、故障/restart 未知与下游禁依赖项分开；没有预裁 FK/trigger/对账机制。 |
| F-02 Append / audit / transport | PASS | 当前文本只保留 D7/D9/S05/S09/S12 要求的判定审计、合法 body 保真、真实 boundary 显式拒绝、socket 异常拒绝而不挂起；明确排除 exactly-once、operation identity、caller 唯一提交判断、session durability/cleanup 保证。 |
| F-03 Persisted exactness | PASS | 只保证合法 row exactness 与明确 boundary failure；未新增 malformed row 逐行容错、跳过或自动清洗。 |
| F-04 Read pagination / response | PASS | 保留 typed pagination、稳定集合与 concurrent append 可见性待定义；未预裁 cursor representation，未发明 response cap。 |
| F-05 Read authorization / classification | PASS | daemon credential identity 是授权权威；CLI 注入与 selector 不被当安全边界。 |
| F-06 Group 合法身份消费 | PASS | 当前文本明确 membership 集合与基数由并行结构层定义；RFC #545 只校验该权威结论，不从 fixture ancestry 自造最近/全部祖先规则。 |
| F-07 Finalize / outcome | PASS | “一切 run”稳定范围未因当前 lifecycle 缺失而缩窄；CAP-IN-4 仍是待供给外部能力。 |
| F-08 Prompt executable addressing | PASS | 只要求最终真实 CLI 可直接执行：自动推导项说明省略，显式 stable key 给合法值；未预造 read flag、未新增 run scope。 |
| F-09 Docs / coexistence | PASS | `shared.md`/context 边界与 GUI read-boundary 所有权清楚；没有新增 GUI/hook 行为。 |
| F-10 Pure proofs / integrated evidence | PASS | fixture、unit、typecheck、静态零命中均只支持等宽主张，不外推生产能力。 |

### B3. 禁止暗增需求

| 风险 | 结论 |
|---|---|
| exactly-once / caller 唯一提交判断 | 未新增；F-02 明确列为不得依赖。 |
| unfinished session TTL、abort、durability 或 cleanup | 未新增；只保留为现状事实，未列为修补后保证。 |
| malformed persisted row 部分容错 | 未新增。 |
| 任意 response cap | 未新增。 |
| nested membership / membership 基数 | 未由本 RFC 定义；交回并行结构层。 |
| run scope | 未新增。 |
| GUI 行为 | 未新增。 |

### B4. 反向覆盖

| 输入 | Foundation 去向 | 结论 |
|---|---|---|
| D-01 | F-01、F-03、F-10 | PASS |
| D-02 | F-02、F-10 | PASS |
| D-03 | F-01、F-03、F-04 | PASS |
| D-04 | F-02、F-04、F-10 | PASS |
| D-05 | F-04、F-05、F-08、F-09 | PASS |
| D-06 | F-01、F-06、F-08、F-10 | PASS |
| D-07 | F-07、F-08、F-10 | PASS |
| P-01 | F-08、F-10 | PASS |
| P-02 | F-04、F-09 | PASS |
| P-03 | F-09、F-10 | PASS |
| K1 | F-06、F-10 | PASS |
| K2 | F-07 | PASS |
| K3 | F-07 | PASS |
| K4a | F-06 | PASS |
| K4b | F-08 | PASS |
| K5 | F-09 | PASS |

账目零遗漏，且每项去向的语义强度与 R7/R8 输入一致。

### B5. R10 可消费性

R10 现在可以从每个 Foundation 明确区分：

1. 稳定产品要求；
2. 当前真实缺陷或缺失能力；
3. 修补完成并取得对应 runtime proof 后才成立的保证；
4. 尚未证明的运行项与外部能力；
5. 下游可以依赖及不得依赖的边界。

预期保证没有依赖当前 store 旁路、空 tools projection、fixture ancestry、`read-no-auth`、不存在的 read API、未统一 trigger/validator lifecycle 或不存在的真实 `par` producer。

### B6. S23 / S44 真实 group 证明

PASS。

- S23 只由真实调度物化容器、两个真实 branch credential 和双向 group 写读证明；
- fixture 只证明 durable shape、parser、admission 等局部性质；
- S44 在冻结 SHA 复核同一 S23，不另造“组件关闭/生产关闭”口径；
- 没有 S45。

### B7. K4b 与未来 CLI boundary

PASS。

K4b 保持在产品可观察结果层：无状态 agent 能按最终 CLI boundary 对当前合法 scope 直接组成 append/read 调用。它没有固定 read subcommand、flag、selector 名称、字段呈现方式或 response shape；自动推导与显式 key 的分界随最终 CLI 合同决定，daemon 仍独立鉴权。

## C. 必须修复项

无。

## D. 非阻塞未知

1. 生产 DB 是否已有 malformed context row；仍需使用生产同一 parser 做只读存量审计。
2. response transport 的真实资源极限；64 MiB 只是已测安全点，不是 cap。
3. 最终 read request/response CLI shape、cursor representation 与 concurrent append 集合定义。
4. 并行结构层的合法 source 数学、权威容器身份/归属结论、真实 producer 与 branch credential 路径。
5. trigger/validator 统一 lifecycle 与共同 finalize 点。
6. 未 checkout 私有仓或生产主机手工脚本是否存在 context consumer。
7. P-01 的 all-phase prompt sentinel 与实际 append/read 命令正向证明；须等待对应能力存在。

这些未知均已显式留在预期地基中，没有被写成已完成能力，也不阻塞 R10 从稳定语义推导需求。

## E. 最终覆盖矩阵

| 审计面 | 结果 |
|---|---|
| aggregate no-legacy | PASS |
| F-01～F-10 五层分离 | PASS |
| D-01～D-07 反向覆盖 | PASS |
| P-01～P-03 反向覆盖 | PASS |
| K1～K5 / K4a / K4b 反向覆盖 | PASS |
| exactly-once / malformed tolerance / cap / nested membership / run scope / GUI 防扩张 | PASS |
| S23/S44 真实 group 证明口径 | PASS |
| K4b 对当前/未来 CLI boundary 的抽象 | PASS |
| R10 输入可用性 | PASS |
