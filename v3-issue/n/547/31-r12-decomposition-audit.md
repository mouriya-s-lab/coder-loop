# RFC #547 R12 最终独立复审

> 审计对象：重写后的 `30-r12-rolling-decomposition.md`。需求/DAG依据为 `28-r11-supply-demand-map.md`；current事实核对项目根 `src/loop.ts`、`package.json`、`docs/test-boundaries.md` 与现有tests。本文只记录当前审计结论，不保留旧缺陷或更正历史；不修改30号、代码、WORKFLOW或GitHub issue。

## A. 最终结论（≤1页）

**通过。缺陷数：0。R12 Complete（合法零批次）。**

30号报告已把expected contract与current supply严格分栏，并给出与main一致的 **0/10** 结论：

- 十个capability unit全部覆盖；source-ready 0，本批issue草案0，not-yet 10。
- dead-fragment不再被误判为source-ready：main只有fragment `id/role/path`与phase role validation，没有S-33要求的versioned typed fragment-ref graph；current finding boundary也只有`verdict/rule/message`，没有S-07 typed carrier。
- 不再保留dead-fragment草案、专用integration文件或虚构命令，也不通过扩大D8 owner范围、弱化transitive/typed finding验收或依赖future issue强行制造批次。
- G-01…G-08是下次滚动读取main时使用的事实gate，不是任务、顺序或issue拆分。

零批次是合法完成形态：R12的交付是对当前source-readiness作出可信、最小、可复查的拆分决定，不是必须产生issue。报告已经完成当前轮10/10核对，并明确只有main事实变化后才重检；它没有把“当前无可拆项”写成blocked，也没有预先指定哪个future issue先补地基。

副作用边界完整：GitHub issue、issue草案、代码、WORKFLOW、worktree、验证命令、integration文件、需求扩张/弱化、实现排序和规模估算均为0。因为本批没有issue草案，不写real-E2E归属句是正确的；项目要求的逐字句只属于未来具体implementation issue body。issue号没有进入合同identity。

因此30号报告已完成R12当前轮职责，后续不是修复本报告，而是在main供给发生变化后启动新的滚动检查。

## B. 0/10选择审计

### B1. 全unit覆盖

| Capability unit | 30号给出的current缺口 | 复审 |
|---|---|---|
| compile contract | S-07 typed finding carrier/input | 与main finding shape一致 |
| typed binding flow | S-03/S-11/S-27 | D1/D10 typed producer未交付 |
| runtime tree/transition | S-04/S-12/S-19/S-21/S-23/S-24/S-28/S-32/S-35/S-36 | 完整输入闭包未形成 |
| tool protocol | S-05/S-13/S-22/S-29及tool runtime | dependency未冒充现有能力 |
| gate protocol | S-06/S-14/S-20/S-30及gate evaluator | carrier未冒充executor/journal |
| doc projection | S-15/S-18/S-31 | typed value/pinned definition未交付 |
| opaque/repository boundary | S-10/S-25 | provider/binding authority未交付 |
| dead-fragment analysis | S-33 producer、S-07 carrier | 与main源码事实一致 |
| chain pin/no-fallback | S-08 typed provider | 本仓未复制provider |
| immutable lifecycle | S-01/S-09/S-16/S-17/S-34 | D10没有吞并相邻domain |

核算：

| 项 | 数量 |
|---|---:|
| R11 capability units | 10 |
| 已逐项核对 | 10 |
| source-ready | 0 |
| 本批issue草案 | 0 |
| not-yet | 10 |
| 遗漏/重复 | 0/0 |

### B2. 为什么零批次合法

零批次同时满足：

1. 没有unit具备“全部输入在main或已交付dependency”；
2. 没有unit能以main+本unit diff独立观察完整owned product；
3. 形成任一草案都会吞并其他owner、弱化冻结需求或暗赖future issue；
4. R12已输出明确的not-yet原因和可重检事实gate；
5. 没有把未ready误写成永久blocked或实施顺序。

所以“0”是gate结果，不是未完成调查。

## C. Dead-fragment事实核对

### C1. S-33 current状态

| main证据 | 当前事实 | 30号判断 |
|---|---|---|
| `src/loop.ts:490-506` | phase为`roles?: string[]`；fragment为`id/role/path` | 一致 |
| `src/loop.ts:730-734` | `PresetFragment`无definition-scoped ref/kind | 一致 |
| `src/loop.ts:4775-4786` | parser收集fragment id/role，duplicate id即普通parse error | 一致 |
| `src/loop.ts:4824-4829,5124-5154` | phase role只校验是否属于declared role universe | 一致 |

main没有：

- versioned canonical fragment graph artifact；
- typed FragmentIdentity/FragmentRef；
- fragment→fragment transitive edge；
- dangling/invalid-kind/cycle ref structure；
- reachability rule/schema version identity。

因此S-33仍是expected seam，不是current producer。

### C2. S-07 current状态

| main证据 | 当前事实 | 30号判断 |
|---|---|---|
| `src/loop.ts:531-532` | compile warning/error只有verdict/rule/message | 一致 |
| `src/loop.ts:580-590` | public findings仍为旧warning数组，schemaVersion 1 | 一致 |

main不能无损承载fragment identity、location、`NoConsumerPath` reason或finding schema version。30号因此拒绝用hand-built result、旁路文件或pure boolean冒充S-07，判断正确。

## D. G-01…G-08事实gate审计

| Gate | 类型 | 是否越界 |
|---|---|---|
| G-01 S-33 producer | main可观察artifact事实 | 否 |
| G-02 S-07 carrier | main public boundary事实 | 否 |
| G-03 rule identity | cache/compile identity事实 | 否 |
| G-04 source-ready闭包 | seam输入完整性判据 | 否 |
| G-05 independent acceptance | 本unit可观察性判据 | 否 |
| G-06 dependency honesty | typed reject/hold/unsupported判据 | 否 |
| G-07 command reality | runner/fixture/日志存在性判据 | 否 |
| G-08 scope stability | owner/需求/compat约束 | 否 |

这些gate没有指定实现者、issue、文件、顺序、规模或方案；观察不到即保持not-yet，不产生机制性要求。它们是合法滚动准入条件。

## E. 命令与验证真实性

### E1. 本轮

本轮没有issue草案，因此：

- 没有验证命令；
- 没有专用integration文件；
- 没有日志路径承诺；
- 没有用测试设计反向扩大scope；
- 没有以`bun test <future-file>`虚构可运行证据。

这与0批次结论一致。

### E2. 下轮约束

30号只要求下次G-07重新核对当时真实存在、或明确属于该unit diff的runner/fixture/log合同，没有预先猜命令。当前项目事实仍支持该策略：

- package scripts真实存在typecheck/unit/integration/all入口；
- integration必须遵循`docs/test-boundaries.md`的批次与`--log-file`合同；
- 是否新增某个fixture必须由未来具体unit边界决定。

报告没有把这些事实提前固化成当前不存在的issue命令。

## F. 副作用、issue与需求权威

| 检查 | 结果 |
|---|---:|
| GitHub issue创建/修改 | 0 |
| issue草案 | 0 |
| 代码实现/修改 | 0 |
| WORKFLOW修改 | 0 |
| worktree创建 | 0 |
| 虚构integration文件/命令 | 0 |
| 需求扩张/弱化 | 0 |
| future issue依赖 | 0 |
| 完整未来树 | 0 |
| 实现排序 | 0 |
| 规模估算 | 0 |
| issue号作为合同identity | 0 |

30号没有具体issue body，因此不写项目要求的real-E2E逐字句是正确边界，而不是遗漏。未来具体implementation issue形成后，才需按项目规则写入其验证边界。

需求权威保持为R9/R10/R11合同；30号只用current main判断准入，没有把旧审计、测试或expected seam改写成新需求。

## G. 完成判定

| 检查 | 结果 |
|---|---|
| 0/10核算 | 通过 |
| 十unit全覆盖 | 通过 |
| expected/current分栏 | 通过 |
| dead-fragment事实 | 通过 |
| G-01…G-08为事实gate | 通过 |
| 无issue/代码/WORKFLOW | 通过 |
| 无虚构命令/fixture | 通过 |
| 无需求膨胀或弱化 | 通过 |
| 无排序/估规模/完整未来树 | 通过 |
| issue号仅出处 | 通过 |
| 缺陷数 | **0** |
| R12 completion | **Complete（合法零批次）** |

## 尾结论

**重写后的R12报告通过最终独立复审：10个capability unit全部核对，current source-ready为0、本批issue草案为0、not-yet为10；dead-fragment的S-33 typed graph producer与S-07 typed finding carrier确实尚未进入main，报告没有再把expected seam冒充current供给。G-01…G-08仅是下次滚动读取main的事实gate，不是future issue、实现顺序或新机制。本轮未创建/修改issue、代码、WORKFLOW或worktree，未虚构integration文件、命令或日志合同，也未扩张/弱化需求。缺陷数0，R12 Complete（合法零批次）。**
