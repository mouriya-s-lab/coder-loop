# RFC #548 R5 — 供给侧 findings 总账

**固定基线：** `main@699842eba2eefc242d19f8fa9232bc1d9d5c3bdd`  
**唯一事实输入：** `supply-main-contract-audit.md`（S1）、`supply-hapi-reconcile-audit.md`（S2）；`AGG-548.md` 仅保留原报告已经引用的稳定条款 ID。  
**边界：** 本总账不重新调查、裁决冲突、提出选项或补法；“R6 候选”仅表示可被下一阶段索引，不表示接受、优先级或方案。

# A. 主 agent 摘要

## A1. 总账规模与覆盖结论

总账共 **81** 条原子记录：设计三态 **35**、偏离/风险细化（含范围/证明边界）**19**、静态未知/证明盲区 **7**、测试资产/同错/盲区 **14**、可保留资产 **3**、需 reconcile 资产 **1**、负资产 **2**。其中 **73** 条具备 R6 索引候选资格；8 条仅为边界、背景或测试资产。

S1、S2 证据附录的设计逐条对照、校验/事务/审计、测试同错与盲区、资产分类、静态未知均已进入稳定 ledger ID；叙述性调用链与证据索引通过章节覆盖表回指相同 ledger ID，不重复制造事实。R5 gate **满足**：双向映射闭合，未发现无来源 ledger 条目，也未发现未映射的证据附录章节。

## A2. 关键互证、冲突与共同接缝

- **互证：** 两份报告都把 runner/CLI→daemon 边界、SQLite 与文件/响应非原子窗口、status/events 的证明强度、测试不能替代真实路径列为限制；二者一致要求区分“内部结构存在”与“下游保证成立”。
- **范围一致但对象不同：** S1 的 CLI/socket 是 GitHub 消费 daemon 的写入运输面；S2 的 runner invocation 是引擎向 external-terminal 的执行面。两者共同触及 CLI、runner、status、closure/终态，但不是同一调用方向，不能互相替代。
- **未裁决冲突/不一致：** S1 认定 main 可作为 T1/T6 窄运输地基；S2 认定历史 HAPI 候选不能作为 T7 地基。两者不直接矛盾。唯一显著范围不一致是 S1 审计 current main，S2 同时比较历史候选与 current closure authority；因此“可保留”含义不同，必须保留来源限定。
- **仍需 follow-up 的报告缺口：** S1 的 kill-point/WAL、并发 chain wire、audit 不可写是未做实验；S2 的真实外部 CLI 合约、真实 remote lifecycle、loss ordering、closure lifecycle、STD-602-9/10 均未验证。它们已登记为未知，不在 R5 内补查。

# B. 证据附录

## B1. 完整总账

### B1.1 S1：main 契约供给

| Ledger ID | 来源（章节/原条目） | 稳定条款 | 类型 | 简明因果与影响分类 | R6候选 |
|---|---|---|---|---|---|
| S1-D01 | B1「§2.1 A 原生面」 | §2.1 A; T1/T6 | 设计三态·符合 | CLI 经本地 Unix socket，未长 HTTP/webhook；当前可作窄运输地基。 | 是 |
| S1-D02 | B1「无凭证=operator」 | §2.1 A | 设计三态·符合 | 本机 socket 无 credential 归 operator；不新增第三方主体。 | 是 |
| S1-D03 | B1「new-workspace 两调用」 | §2.1 C; T1 | 设计三态·符合/边界 | `chain.create` 与 `item.add` 可达但非原子，部分失败依赖重放。 | 是 |
| S1-D04 | B1「chain.create 同字段幂等」 | §2.1 C; T3 | 设计三态·偏离 | 串行复用；并发读后写竞态使败者落未归一化错误。 | 是 |
| S1-D05 | B1「item.add 唯一拒绝」 | §2.1 C; T3/T5 | 设计三态·部分符合/偏离 | DB 唯一性成立，但 duplicate 是失败 conflict，CLI 无 typed already-exists 成功分支。 | 是 |
| S1-D06 | B1「per-item preset」 | §2.1 D | 设计三态·符合 | CLI 与 daemon 都要求每 item preset 引用。 | 是 |
| S1-D07 | B1「compile 预校验面」 | §2.1 D; T2; STD-745 | 设计三态·偏离 | compile 仅 8-key projection instance，无 item schema/type/required artifact。 | 是 |
| S1-D08 | B1「创建期 required」 | §2.1 D; §2.2; T2 | 设计三态·偏离 | grammar 无 required，item.add 无声明字段完整性兜底。 | 是 |
| S1-D09 | B1「三层校验」 | §2.2; T2 | 设计三态·偏离 | 仅 CLI/socket parse 层存在，产物预校验与 required 兜底缺失。 | 是 |
| S1-D10 | B1「item 唯一」 | §2.2; T3 | 设计三态·符合 | `(chain,itemId)` UNIQUE 可作最多一 item 的存储地基。 | 是 |
| S1-D11 | B1「未声明字段拒绝」 | §2.2; T2 | 设计三态·偏离 | top-level unknown 拒绝，但 `extra` 未声明字段可入库。 | 是 |
| S1-D12 | B1「类型不符拒绝」 | §2.2; T2 | 设计三态·偏离 | item.add 不按 preset field map 校验 `extra` 类型。 | 是 |
| S1-D13 | B1「preset 不存在」 | §2.2; T2 | 设计三态·符合 | preset load/validate 在 insert 前，失败无部分 item。 | 是 |
| S1-D14 | B1「任意前缀失败重放」 | T3; P-746-3 | 设计三态·偏离 | DB/event/reply 分离；item replay conflict，chain 并发可非结构化错误。 | 是 |
| S1-D15 | B1「verdict 忠实」 | T5; P-746-4 | 设计三态·偏离 | socket details 尚可，通用 CLI 将其压平为 stderr，难以忠实分类。 | 是 |
| S1-D16 | B1「既有事件覆盖入队审计」 | LOG-746 | 设计三态·偏离 | duplicate 无 created event，chain replay不可区分，append 吞错且非事务。 | 是 |
| S1-D17 | B1「外挂仅 CLI」 | T6; P-746-1/P-746-5 | 设计三态·符合 | 生产外部面是 CLI；报告未发现新增 GitHub ingress 知识。 | 是 |
| S1-D18 | B1「消费端 ADT」 | P-746-6 | 设计三态·静态不可判定 | 消费 daemon 树外；main 只能提供 daemon response shape。 | 是 |
| S1-R01 | B2「projection/artifact boundary」 | T2; STD-745; P-747-3 | 偏离细化 | `schemaVersion` 只版本化 projection instance，不能证明 schema 可分发/派生。 | 是 |
| S1-R02 | B3「item.batchAdd」 | §2.1 C | 范围边界 | batch 是另一生产写入口但不把 chain.create 原子化，不能替代两步裁决。 | 否 |
| S1-R03 | B3「主体准入」 | §2.1 A | 范围边界 | operator/agent rights 是本机主体准入，不是第三方鉴权。 | 否 |
| S1-R04 | B4「preset/known-key 拒绝」 | T2; P-747-2 | 可保留行为 | preset spec/load 与 top-level known-key 在 DB 前拒绝，但 CLI 丢 details。 | 是 |
| S1-R05 | B4「extra 三种违规」 | T2; P-747-1/2/4 | 偏离细化 | 未声明、类型不符、漏 required 均可成功入库；required 甚至无 grammar。 | 是 |
| S1-R06 | B4「错误 details 不统一」 | P-747-2 | 偏离细化 | 部分 parser error 无统一 `details.field`，socket 结构化也未达四类 typed verdict。 | 是 |
| S1-R07 | B5「chain 同字段定义」 | T3 | 语义细化 | 实际相等是固定标量相等加请求 metadata 子集不冲突，不是完整对象相等。 | 是 |
| S1-R08 | B5「事务与并发」 | T3 | 偏离细化 | IMMEDIATE/WAL/UNIQUE 不覆盖 handler 外 existing lookup；chain race 未归一。 | 是 |
| S1-R09 | B5「提交后未确认窗口」 | T3/T5 | 偏离细化 | SQLite commit 后 event/reply 前可崩溃，形成已提交但调用方/审计不确定的第四形态。 | 是 |
| S1-R10 | B6「日志证明力」 | LOG-746; T5 | 偏离细化 | rights event 只证准入；created 是 best-effort；status/list 是事后当前态而非逐决策审计。 | 是 |
| S1-R11 | B7「历史 migration」 | §2.2 | 背景/边界 | migration 保住历史 opaque item identity/per-item preset 读调度，但不制造 required 或 duplicate CLI 语义。 | 否 |
| S1-A01 | A「可保留资产」；B3/B5 | §2.1 A/C; T1/T3/T6 | 可保留资产 | Unix socket/CLI、caller ADT、串行 chain compare、IMMEDIATE/WAL/UNIQUE 是窄地基。 | 是 |
| S1-A02 | A「可保留资产」；B4/B6 | T2/T5; LOG-746 | 可保留资产 | pre-insert 通用校验、batch transaction、socket response ADT、typed event boundary 可保留，但不等于目标保证。 | 是 |
| S1-T01 | B8 可保留覆盖「compile」 | T2 | 测试资产 | 现有测试覆盖 current compile closed ADT/确定性/成功拒绝。 | 否 |
| S1-T02 | B8 可保留覆盖「chain/item/batch/admission」 | T1/T3 | 测试资产 | 现有集成覆盖串行 chain、socket duplicate、top-level strict、batch 原子拒绝和 admission。 | 否 |
| S1-T03 | B8 同错 1「compile oracle」 | T2; STD-745 | 测试同错 | producer 与 oracle 同源，绿色会稳定缺 item schema 的 8-key projection。 | 是 |
| S1-T04 | B8 同错 2「strict-fields」 | T2 | 测试同错 | 测试把 top-level unknown 与 preset `extra` 混淆，并显式接受未对照字段表的 note。 | 是 |
| S1-T05 | B8 同错 3「chain idempotency」 | T3 | 测试盲区 | 只有串行，无同名并发、kill 或断连重放。 | 是 |
| S1-T06 | B8 同错 4「duplicate helper」 | T5 | 测试盲区 | 直连 socket 可见 details，未验证 PATH CLI 的扁平 stderr。 | 是 |
| S1-T07 | B8 同错 5「audit」 | LOG-746 | 测试盲区 | 只证正常文件事件，未覆盖 append 失败、duplicate 无事件、chain replay 不可区分。 | 是 |
| S1-T08 | B8 同错 6「harness 默认 preset」 | §2.1 D | 测试盲区 | harness 自动补 preset，源码省略不能否定生产 per-item preset 要求。 | 否 |
| S1-U01 | A/B5/B8「故障注入」 | T3/T5; LOG-746 | 静态未知/证明盲区 | kill-point WAL 最终可见性、并发 chain wire、audit 不可写尚未实验。 | 是 |
| S1-U02 | A「T2 artifact 形态」 | T2; STD-745 | 设计待裁/未知 | schema artifact 形态、required grammar、CLI 成功/duplicate ADT 尚无供给侧事实。 | 是 |

### B1.2 S2：HAPI / external-terminal reconcile

| Ledger ID | 来源（章节/原条目） | 稳定条款 | 类型 | 简明因果与影响分类 | R6候选 |
|---|---|---|---|---|---|
| S2-D01 | B1「runner domain」 | T7 | 设计三态·静态符合 | 历史 ADT 穷尽 local-process/external-terminal。 | 是 |
| S2-D02 | B1「availability 消费 domain」 | T7 | 设计三态·大体符合 | scheduler probe 经 domain ADT；invocation builder 仍 HAPI 特判。 | 是 |
| S2-D03 | B1「无 HAPI HTTP」 | T7; STD-602-8 | 设计三态·静态符合 | 候选引擎仅 binary/probe/headless；外部 CLI 边界未验证。 | 是 |
| S2-D04 | B1「probe typed」 | T7; STD-602-2 | 设计三态·部分符合 | 字面 `probe` 和分类存在，但所有 child error 都误映 executable-missing。 | 是 |
| S2-D05 | B1「创建立即 hold」 | T7; STD-602-2 | 设计三态·部分符合 | item 先 commit、probe/hold 后写，crash 可短暂留下无 hold durable item。 | 是 |
| S2-D06 | B1「side-effect 前 gate」 | T7 | 设计三态·符合 | candidate gate 在 worktree/run/attempt/credential/session/artifact/process 前。 | 是 |
| S2-D07 | B1「absent 不改状态」 | T7; STD-602-2 | 设计三态·覆盖路径符合 | hold 仅进 extra，历史 fixture 断言零运行副作用。 | 是 |
| S2-D08 | B1「restore 自动真实执行」 | T7; STD-602-2 | 设计三态·明确偏离 | 恢复终点是 invocation-pending，不会真实 spawn。 | 是 |
| S2-D09 | B1「真实 invocation 契约」 | T7; STD-602-1 | 设计三态·明确偏离 | builder 返回 pending 并抛错，完整 prompt/cwd/status/resume/auth 不可达。 | 是 |
| S2-D10 | B1「同构 completion/retry」 | T7 | 设计三态·不可达 | generic local pipeline 存在但 HAPI 进不去，session parser 返回 null。 | 是 |
| S2-D11 | B1「active loss 同路」 | T7; STD-602-3 | 设计三态·不可达/偏离 | loss latch 代码存在，却无真实 active HAPI run 来源。 | 是 |
| S2-D12 | B1「total order」 | T7; STD-602-4 | 设计三态·有模型无生产证明 | close 可读 durable latch，但真实 HAPI 路径不可达。 | 是 |
| S2-D13 | B1「status/events/holds」 | T7; STD-602-7 | 设计三态·静态符合有限 | synthetic/persisted state 可观察，不能报告真实 active HAPI。 | 是 |
| S2-D14 | B1「endpoint identity」 | T7 | 设计三态·条件等价 | key 实为 kind+binary；仅因 argv 固定 probe 才等价，argv 变化会混淆。 | 是 |
| S2-D15 | B1/B4「closure lifecycle」 | T7; STD-748-B1 | 设计三态·相对 main 偏离 | 历史 slot/item owner 与 current durable closure owner 竞争。 | 是 |
| S2-D16 | B1「真实 E2E」 | T7; STD-602-1 | 设计三态·缺失 | 历史验收以 zero-hapi-spawn 为 PASS，不能证明 remote session。 | 是 |
| S2-D17 | B1「本地回归/卫生」 | STD-602-9/10 | 设计三态·证据不足 | focused fake tests 不等于 candidate 与 merge-base gate。 | 是 |
| S2-R01 | B2「完整调用链」 | T7 | 偏离细化 | HAPI vocabulary 已进入 parser/storage，但 spawn/status/admission 路径被 pending gate 截断。 | 是 |
| S2-R02 | B2/B3「三类状态」 | T7 | 可保留行为/缺陷 | absence、spawn failure、active loss shape 分离；额外 pending variant 与 available⇒invoke 冲突。 | 是 |
| S2-R03 | B2「active loss/recovery」 | T7; STD-602-3/5 | 证明边界 | latch/revoke/terminate/startup recovery 静态存在；synthetic active state 不证真实路径。 | 是 |
| S2-R04 | B4「历史/current owner」 | T7; STD-748-B1 | reconcile 偏离 | 历史 slot path与 item session；main closure path、run identity、reachability、intent、cleanup 已成 authority。 | 是 |
| S2-R05 | B5「migration」 | T7 | 负向风险 | 历史 whole-table CHECK rebuild 是旧组合，重放可能破坏 current closure schema/invariants。 | 是 |
| S2-R06 | B5「非事务窗口」 | T7 | 偏离细化 | probe、hold、warning、restoration、loss/termination 与 DB mutation 非同事务。 | 是 |
| S2-R07 | B5「race/crash」 | T7 | 偏离细化 | create→hold crash、probe→spawn loss、clear hold→pending、slot cleanup 缺 current intent recovery。 | 是 |
| S2-R08 | B6「公平/传播」 | T7 | 范围边界 | held item 让位且不改 preset status；只证明相关公平性，不外推 starvation/dependency 保证。 | 否 |
| S2-A01 | B8「可保留」 | T7 | 可保留资产 | execution-domain/probe ADT、hold/current/loss shape、status/event vocabulary、focused test ideas可隔离保留；均带复核条件。 | 是 |
| S2-A02 | B8「必须 reconcile」 | T7 | 需 reconcile 资产 | loop/task-runtime/sqlite/scheduler/daemon/runtime-data/observability/tests 必须对 current closure 与真实 invocation 复核。 | 是 |
| S2-N01 | B8「负资产」前半 | T7 | 负资产 | probe-only、invocation-pending、HAPI throw、zero-hapi-spawn 直接固化错误终点。 | 是 |
| S2-N02 | B8「负资产」后半 | T7 | 负资产 | slot owner、item session、历史 whole-table migration、synthetic loss proof 与 current authority/真实证据冲突。 | 是 |
| S2-T01 | B7「覆盖机制」 | T7 | 测试资产 | fake tests 覆盖 probe/gate/fairness/restoration/latch/race/status/startup/migration 机制。 | 否 |
| S2-T02 | B7 同错「pending expectation」 | T7 | 测试同错 | unit 明确期待 HAPI invocation-pending。 | 是 |
| S2-T03 | B7 同错「integration pending」 | T7 | 测试同错 | scheduler integration 把 pending 后释放 slot 当目标。 | 是 |
| S2-T04 | B7 同错「zero spawn」 | T7; STD-602-1 | 测试同错 | 脚本明确以恢复后不 spawn、zero-hapi-spawn 为 PASS。 | 是 |
| S2-T05 | B7 同错「synthetic active loss」 | T7; STD-602-3/4 | 测试同错 | active-loss 由构造/替代状态产生，不是同一真实 HAPI invocation。 | 是 |
| S2-T06 | B7「盲区」 | T7; STD-602-1..10 | 测试盲区 | 无真实 machine/CLI/status admission/#749 closure/concurrency/完整 gates。 | 是 |
| S2-U01 | B9.1「外部 CLI 合约」 | T7; STD-602-1/8 | 静态未知 | argv、probe、prompt、cwd、auth、resume/session、exit/status schema 未核实。 | 是 |
| S2-U02 | B9.2「真实 remote lifecycle」 | T7; STD-602-1 | 静态未知 | 隔离 daemon 经真实 CLI/HAPI 到 status admission 尚未执行。 | 是 |
| S2-U03 | B9.3「loss ordering」 | T7; STD-602-3/4 | 静态未知 | 同一生产 invocation 的 loss-first/terminal-first 尚未复现。 | 是 |
| S2-U04 | B9.4「closure semantics」 | T7; STD-748-B1 | 静态未知 | retry/resume reuse、consume cleanup、stop/delete/restart 未在 current authority 下验证。 | 是 |
| S2-U05 | B9.5「local regression」 | STD-602-9/10 | 静态未知 | immutable candidate 与 live merge-base 完整 gate 尚未运行。 | 是 |

## B2. 跨报告共同接缝（只登记证据）

| 接缝 ID | 共同触点 | S1 证据 | S2 证据 | 为什么是接缝（不推导方案） |
|---|---|---|---|---|
| J01 | CLI / 进程边界 | S1-D01/D15/D17 | S2-D03/D09/R01 | 两侧都依赖外部可执行文件边界；一侧是消费 daemon→coder-loop，另一侧是 coder-loop→HAPI。 |
| J02 | runner / caller 类型 | S1-D02/R03 | S2-D01/D02/A01 | 两侧均以 ADT/准入区分执行主体或执行域，但关注层次不同。 |
| J03 | socket/response 与 terminal/status | S1-D15/R09/R10 | S2-D09/D10/D13 | 下游 verdict 或 phase 推进都依赖结构化终态能否穿过边界；两报告均指出当前证明不完整。 |
| J04 | SQLite→文件/event→响应非原子 | S1-R09/R10 | S2-R06/R07 | 两侧均出现 durable mutation 与观测/外部确认分离的 crash window。 |
| J05 | 重试、resume 与 identity | S1-D04/D05/D14 | S2-D10/D15/R04 | 两侧都要求重复调用绑定到稳定 identity；S1 是 chain/item，S2 是 closure/run/session。 |
| J06 | closure / cleanup / consumed | S1-D15/R09 | S2-D15/R04/U04 | “已接管/终态”会影响后续资源或 verdict；S2 有 current closure authority，S1只审计入队事实。 |
| J07 | 测试与真实路径 | S1-T03..T08/U01 | S2-T02..T06/U01..U05 | 两报告都发现绿色或 synthetic fixture 可与目标语义共同偏离。 |
| J08 | observability / audit | S1-D16/R10 | S2-D13/R03 | 两侧都有 typed event/status 资产，但都不能单独证明真实跨边界终态。 |

## B3. 互证、冲突与范围不一致

| ID | 类型 | 条目 | 登记结论（不裁决） |
|---|---|---|---|
| X01 | 互证 | J01/J07 | 两报告一致区分“接口/测试存在”与“稳定能力成立”。 |
| X02 | 互证 | J04/J08 | 两报告一致指出 DB 与文件事件/外部确认之间没有原子证明。 |
| X03 | 互证 | S1-D15、S2-D09/D10 | 结构化终态若未穿过实际外部边界，消费者或 scheduler 不能可靠分类。 |
| X04 | 互证 | S1-D14、S2-D10/D15 | retry/resume 的保证都依赖稳定 identity 与可达真实路径。 |
| X05 | 范围不一致 | S1 current main；S2 历史候选+current main | S1 的“可保留”是 current transport/storage；S2 的“可保留”是历史资产隔离后候选，不得合并成同强度结论。 |
| X06 | 非冲突 | S1-D01/D17 与 S2-D08/D09 | main 的 GitHub 消费 CLI 运输可达，不等于历史 HAPI runner invocation 可达；调用方向不同。 |
| X07 | 报告内保留不确定 | S1-U01/U02 | S1 已把故障注入与 artifact 形态留为未知，总账不补写。 |
| X08 | 报告内保留不确定 | S2-U01..U05 | S2 未验证真实 HAPI/closure/gates，总账不把静态机制升级为能力。 |
| X09 | 未发现直接矛盾 | 全部 | 两报告无同一基线、同一对象、同一条款上的相反事实；存在的是对象/时间范围差异。 |

## B4. 来源 → Ledger 覆盖表

| 来源 | 覆盖 Ledger ID |
|---|---|
| S1 A 摘要/结论/资产/未知 | S1-D01..D18, S1-A01..A02, S1-U01..U02 |
| S1 B1 设计逐条对照（18 行） | S1-D01..D18 |
| S1 B2 compile artifact | S1-D07..D09, S1-R01, S1-T03, S1-U02 |
| S1 B3 调用链/旁路/主体 | S1-D01..D06, S1-D17, S1-R02..R03, S1-A01 |
| S1 B4 校验拒绝表（9 行） | S1-D05..D13, S1-D15, S1-R04..R06 |
| S1 B5 串行/并发/crash | S1-D04..D05, S1-D10, S1-D14, S1-R07..R09, S1-U01 |
| S1 B6 审计证明力（6 bullet+结论） | S1-D16, S1-R10, S1-A02 |
| S1 B7 migration（5 bullet） | S1-R11 |
| S1 B8 可保留覆盖（5 bullet） | S1-T01..T02 |
| S1 B8 同错/盲区（6 项） | S1-T03..T08 |
| S1 B8 后续实验（4 项） | S1-U01（前三项）, S1-D11..D12/S1-R05（第四项既有偏离的实验化） |
| S1 B9 索引/限制 | 上述 S1 全部；限制=S1-U01 |
| S2 A 摘要/结论/资产/缺口 | S2-D01..D17, S2-A01..A02, S2-N01..N02, S2-U01..U05 |
| S2 B1 设计逐条对照（17 行） | S2-D01..D17 |
| S2 B2 调用链 | S2-D01..D13, S2-R01..R03 |
| S2 B3 ADT/入口消费者 | S2-D01..D04, S2-D08..D13, S2-R02 |
| S2 B4 历史/current lifecycle | S2-D15, S2-R04, S2-A02, S2-N02 |
| S2 B5 schema/事务/crash | S2-R05..R07, S2-U03..U04 |
| S2 B6 队列/传播（5 bullet） | S2-D06..D07, S2-R08 |
| S2 B7 覆盖机制 | S2-T01 |
| S2 B7 共同偏离（4 项） | S2-T02..T05 |
| S2 B7 盲区 | S2-T06 |
| S2 B8 可保留/需 reconcile/负资产 | S2-A01..A02, S2-N01..N02 |
| S2 B9 未知/实验（5 项） | S2-U01..U05 |
| S2 B10 证据索引/B11 自检 | 上述 S2 全部；不另生事实 |

## B5. Ledger → 来源闭合规则

- 每个 `S1-*` 行的“来源”列均回指 S1 的具体章节/原条目；每个 `S2-*` 行同理。
- `J*` 只引用已登记 ledger，不新增供给事实；`X*` 只登记两报告之间的关系。
- 原报告的源码路径、命令与行号属于报告证据，本总账不重新核验，也不把 B9/B10 的重复证据索引计为新 finding。
- 报告中的 Mermaid 调用链/时序图是相邻文字的结构化复述，映射到 S1-R09、S2-R01/R06，不重复计数。
- S1 B8 第四个“后续实验”把已静态判定的三种字段偏离做实验化，并非新的未知；因此回指既有偏离而不新增 ledger。

## B6. 计数校验与遗漏核对

| 分类 | S1 | S2 | 合计 |
|---|---:|---:|---:|
| 设计三态 | 18 | 17 | 35 |
| 偏离/风险细化（含范围/证明边界） | 11 | 8 | 19 |
| 静态未知/证明盲区 | 2 | 5 | 7 |
| 测试资产/同错/盲区 | 8 | 6 | 14 |
| 可保留资产 | 2 | 1 | 3 |
| 需 reconcile 资产 | 0 | 1 | 1 |
| 负资产 | 0 | 2 | 2 |
| **逐类计数（每行只归一类）** | **41** | **40** | **81** |

> 计数说明：B1 实际 ledger 行为 **81**。分类按表中主类型单归类；例如带“可保留行为/缺陷”字样的 `S2-R02` 仍归入偏离/风险细化，不重复计入可保留资产。

遗漏核对：S1 B1 的 18 行、B4 的 9 情形、B8 的 6 个同错/盲区及 4 个实验均有映射；S2 B1 的 17 行、B7 的 4 个共同偏离与盲区、B8 三类资产、B9 五个未知均有映射。其余附录章节均在 B4 覆盖表中闭合。未遇到无法拆解且需要自行补写事实的报告表述；仅 S1“可保留资产”多项合并为两个 ledger，S2“必须 reconcile”触点合并为一个 ledger，均保留完整章节回指而未升级为新结论。
