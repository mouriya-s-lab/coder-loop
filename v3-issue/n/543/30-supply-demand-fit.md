# RFC #543 · R11 供需匹配与接缝识别

> 输入边界：本文只读 `23-expected-foundation.md`、`25-demand-observer-payload.md`～`29-demand-script-join-reopen.md`、`20-external-contract-resolution.md`、`21-runtime-consistency-resolution.md`、`22-observer-process-resolution.md`。未读源码、未运行实验、未创建 worktree、未实现代码、未拆 issue，也不安排实现顺序。这里的“供给”是合同资格，不是当前 main 已实现的事实。

## A. 摘要

五份需求侧报告共有 **133** 个原子 ID，全部完成唯一分类，未映射 **0**。匹配结果是：直接复用 **10**，修补后复用 **13**，过渡兼容 **3**，消费能力自建 **85**，地基仍缺 **22**。

供需关系没有形成五套独立 runtime。observer、gate、join 共同消费一套 pinned payload/projection、一套 delivery/execution/evaluation/attempt identity、一套 decision ADT 与 typed ingress、一套 journal/recovery，并通过 operator mutation/audit、metadata current-state mutation、hook diagnostic、named binding、closure/reopen authority 等明确接缝相连。本文为 11 个交叠域各指定唯一 seam owner 与原子合同，消除“双方各吞半个”的责任空洞。

地基仍缺均保持原 RFC owner：RFC-2 提供 pinned definition/public compile projection 与 typed additive DSL variant；RFC-1 提供 closure transition/join-ready/canonical host-target facts以及 structured reopen authority。#543 只建 consumer，不以当前路径重编译、旧 `closure.*` 推断、本地 journal、metadata carrier 或临时 resolver 代替外部权威。

## B. 分类规则

| 分类 | 唯一判据 |
|---|---|
| 直接复用 | 指定输入已经给出可直接消费的稳定边界或明确非保证；#543 只接入，不需要先补该供给合同。 |
| 修补后复用 | `23` 已规定修补后的结果合同，但当前资格依赖同 RFC 地基先补齐；消费方不得复制第二实现。 |
| 过渡兼容 | 新 authority 必须与旧 carrier/旧专用状态机隔离，保留读取兼容但不得让旧值成为新权威。 |
| 消费能力自建 | 需求属于 #543 的 evaluator、dispatcher、binding resolver、journal consumer、typed ingress、status/event 等消费面。 |
| 地基仍缺 | 完成主张依赖 RFC-1/RFC-2 尚未供给的权威事实或公共投影；owner 不转移到 #543。 |

分类互斥且穷尽。一个需求若同时含消费行为和外部前置，按其主要交付责任归类；外部前置仍在 seam 矩阵登记为 blocker，避免用重复计数掩盖接缝。

## C. 逐片映射

### C1. Observer execution / payload / diagnostic（30）

| 分类 | 原子 ID | 数量 | 供需解释 |
|---|---|---:|---|
| 直接复用 | O-11、O-17、O-24、O-27～O-29 | 6 | 共用 typed envelope/projection、`hook.*` 结构排除、operator admission、外部 effect 非保证与 scheduler 旁路边界可直接消费。 |
| 修补后复用 | O-05 | 1 | 先抽取领域无关 async subprocess primitive，再由 observer/agent adapter 共用；不得直接复用混有 agent 领域状态的 executor。 |
| 过渡兼容 | — | 0 | 本片无旧 authority 兼容项。 |
| 消费能力自建 | O-01～O-04、O-06～O-10、O-12～O-13、O-16、O-18～O-23、O-25～O-26、O-30 | 21 | #543 建 delivery/attempt ownership、固定 payload、terminal/diagnostic、并发与 retention consumer 闭环。 |
| 地基仍缺 | O-14～O-15 | 2 | RFC-2 pinned resolver/public projection；RFC-1 canonical closure transition identity/snapshot。 |

### C2. Gate evaluator（32）

| 分类 | 原子 ID | 数量 | 供需解释 |
|---|---|---:|---|
| 直接复用 | — | 0 | evaluator 的原子行为均尚需新 consumer 或修补后的 runtime 地基。 |
| 修补后复用 | GE-11～GE-14、GE-23～GE-24、GE-26 | 7 | durable evaluation/decision/pending、write-ahead、原子消费、shutdown admission、current-state mutation 与 scoped replay 由 `23` 的修补合同供给。 |
| 过渡兼容 | GE-18 | 1 | fingerprint 建新独立 authority，旧 keep-active metadata 只隔离保留，不迁入新状态机。 |
| 消费能力自建 | GE-01～GE-10、GE-15～GE-17、GE-19～GE-22、GE-25、GE-27～GE-28、GE-32 | 21 | #543 建八点 evaluator、三词 decision、四层合成、fingerprint/tick、typed lifecycle outcome 与观察面。 |
| 地基仍缺 | GE-29～GE-31 | 3 | subprocess/pinned payload 的 RFC-2 供给，以及 RFC-1 structured reopen authority 尚未齐。 |

### C3. Evaluation journal（26）

| 分类 | 原子 ID | 数量 | 供需解释 |
|---|---|---:|---|
| 直接复用 | EJ-16、EJ-20～EJ-21 | 3 | 普通 operator 语义、SQLite immediate/WAL 局部原子底料、operator typed auth/validation/audit 可直接保留。 |
| 修补后复用 | EJ-15、EJ-19 | 2 | correlation audit 与 metadata current-state mutation 需按 `23` 修补后由 journal 消费。 |
| 过渡兼容 | EJ-18 | 1 | 新 fingerprint/epoch authority 不读旧 keep-active carrier；旧值存在不影响首次 evaluation。 |
| 消费能力自建 | EJ-01～EJ-14、EJ-17 | 15 | #543 建 point/evaluation/execution/delivery identity、typed ingress、唯一 decision、pending progress、scoped mutation replay 与 fingerprint。 |
| 地基仍缺 | EJ-22～EJ-26 | 5 | RFC-2 pinned projection/payload，以及 RFC-1 target/claim/budget/cursor/terminal preservation。 |

### C4. Named gate binding（18）

| 分类 | 原子 ID | 数量 | 供需解释 |
|---|---|---:|---|
| 直接复用 | — | 0 | 现有 hook declaration/layering 只是底料，尚不能单独满足任一 named-binding 原子结果。 |
| 修补后复用 | — | 0 | binding resolution 自身由 #543 建；pinned definition 前置单列为外部缺口。 |
| 过渡兼容 | — | 0 | optional-unbound 的恢复是新 pinned 语义，不是旧 authority 迁移。 |
| 消费能力自建 | NB-04～NB-18 | 15 | #543 拥有 typed binding parse、operator admission、chain-over-global 唯一选择、三态、创建准入、resolution pin、恢复 hold、统一 evaluator 与 selected/shadowed 可见性。NB-13 的 resolver 前置由 seam blocker约束，但恢复消费责任仍在 #543。 |
| 地基仍缺 | NB-01～NB-03 | 3 | RFC-2 必须提供无本机路径的 typed `name + point + required|optional` 公共 compile projection，并与现场 availability 解耦。 |

### C5. Script join / reopen（27）

| 分类 | 原子 ID | 数量 | 供需解释 |
|---|---|---:|---|
| 直接复用 | SJ-09 | 1 | payload 不注入 GitHub/external truth、外部 effect 不由引擎兜底，是已裁稳定边界。 |
| 修补后复用 | SJ-07～SJ-08、SJ-13 | 3 | join 消费唯一 pinned payload envelope 与 evaluation-scoped mutation replay；RFC-2 供给未齐时相关完成主张仍 blocked。 |
| 过渡兼容 | SJ-27 | 1 | 顶层 chain join 迁入统一 ADT/journal/consumer，旧 keep-active carrier 不作 authority。 |
| 消费能力自建 | SJ-02～SJ-03、SJ-05～SJ-06、SJ-10～SJ-12、SJ-14、SJ-21～SJ-25 | 13 | #543 建 script adapter/ingress、identity、point legality、hold、correction reference、纯合成、decision+pending 与恢复消费。 |
| 地基仍缺 | SJ-01、SJ-04、SJ-15～SJ-20、SJ-26 | 9 | RFC-2 additive typed script variant；RFC-1 join-ready、claim、target、cursor、budget、原子 reopen、terminal preservation 与顶层 canonical facts。 |

### C6. 全覆盖核算

| 需求片 | 直接复用 | 修补后复用 | 过渡兼容 | 消费能力自建 | 地基仍缺 | 总数 |
|---|---:|---:|---:|---:|---:|---:|
| O | 6 | 1 | 0 | 21 | 2 | 30 |
| GE | 0 | 7 | 1 | 21 | 3 | 32 |
| EJ | 3 | 2 | 1 | 15 | 5 | 26 |
| NB | 0 | 0 | 0 | 15 | 3 | 18 |
| SJ | 1 | 3 | 1 | 13 | 9 | 27 |
| **合计** | **10** | **13** | **3** | **85** | **22** | **133** |

未映射 ID：**0**。重复计数 ID：**0**。

## D. Seam 矩阵

| Seam | 唯一 owner | Provider | Consumer | 原子合同 | 外部 blocker |
|---|---|---|---|---|---|
| S-01 subprocess primitive | #543 runtime foundation | 领域无关 async primitive；agent adapter 回归事实 | observer dispatcher、gate/join script adapter | primitive 只产出 spawn/error、stdio、process-group、timeout、TERM→KILL、close 过程事实；不含 delivery/item/phase/session/backoff；child 取得执行资格前 ownership 可恢复 | 无 |
| S-02 pinned payload / projection | RFC-2 对定义权威负责；#543 对 runtime assembly负责 | RFC-2 pinned definition resolver + public compile projection；#543 event/runtime snapshot boundaries | observer、gate、join | 同一 delivery/evaluation 的业务 payload 版本与字节语义固定；attempt identity可变但与 stable delivery/evaluation 关联；missing/corrupt/version typed failure且无 current-path fallback | **RFC-2-PIN / RFC-2-RESOLVER** |
| S-03 delivery / execution / evaluation / attempt identity | #543 journal | lifecycle event identity、point/host identity、pinned instance identity | dispatcher、typed ingress、audit、diagnostic、recovery | delivery/evaluation 标识逻辑工作；execution/attempt 标识一次真实运行；一对多链接不可覆盖/复用；迟到结果必须匹配当前 epoch/attempt并 typed reject | closure transition identity仍由 RFC-1；definition identity由 RFC-2 |
| S-04 decision ADT + typed ingress | #543 evaluator | script/validator kind-specific parser | 单一 decision journal/consumer | parser 只产出 `advance|hold|reopen` ADT或穷尽 typed failure；point×decision合法性在一个 boundary判定；不得形成 script/validator 双状态机 | RFC-2 需供给 typed script variant；RFC-1 供给 reopen legality/effect |
| S-05 journal / recovery | #543 journal | SQLite局部事务、stable identity、typed terminal/outcome | gate consumer、observer diagnostic derivation、status/audit | evaluating 在 spawn 前 write-ahead；decision与pending intent原子建立；每步 durable outcome；terminal/consumed仅在引擎 owned outcomes齐全后成立；restart无需原触发点恢复 | structured reopen的外部效果仍由 RFC-1 authority原子完成 |
| S-06 operator mutation / audit | operator command boundary | 既有 operator auth/validation + evaluation scope injector | correction creation、binding mutation、hook CLI | mutation key=`evaluation identity + command + canonical args`；首次 mutation与typed response同事务；replay零新增DB/event/spawn副作用；普通 operator不进入scoped幂等分支；audit保留因果identity | 外部资源 effect 不纳入引擎事务 |
| S-07 metadata current-state mutation | runtime metadata boundary | durable current state + typed mutation/conflict | gate fingerprint/lifecycle、binding状态、status | 成功 mutation不得以stale whole snapshot静默覆盖并发已提交状态；同字段竞争得到确定结果或typed conflict；新增 writer必须经过同 boundary | 无 |
| S-08 hook event / diagnostic | observer execution terminal authority | execution terminal +统一 event sink | status/log/event readers；observer matcher只消费非`hook.*` | terminal先权威持久；`hook.*`是带稳定execution因果identity的可恢复at-least-once派生；append/confirm间可重复；sink失败不改scheduler、不重跑终态delivery；声明和emission双层零自反 | 无 |
| S-09 named binding | #543 binding resolver | RFC-2抽象 named declaration；operator global/chain binding store | preset-layer gate evaluator | chain-over-global只选一个effective script；bound/optional-unbound/required-unbound穷尽；创建+definition pin+resolution+runnable不可撕裂；恢复固定resolution，required缺失hold且零fallback；selected/shadowed可见、shadowed零执行 | RFC-2 public projection/resolver |
| S-10 closure transition | RFC-1 | canonical 六边 transition producer、transition identity、发生时点snapshot | observer event matcher/payload assembler | 六边事实只由权威状态转移产生；transition identity与delivery identity分离；#543不得从旧主题事件推断补齐 | **RFC-1-CLOSURE-TRANSITION / EDGE-IDENTITY** |
| S-11 closure/reopen authority | RFC-1 | join-ready/host-target/correction claim/budget/cursor/lifecycle authority | #543 合成后的单一 reopen decision consumer | #543只提交evaluation/decision identity、opaque target与精确correction IDs；authority穷尽校验并令claim+target reopen+cursor+budget+decision consumed全有或全无；terminal item不改写、consumed closure不复活；重复/冲突返回typed outcome | **RFC-1-REOPEN-TARGET / CORRECTION-CLAIM / REOPEN-BUDGET / REOPEN-EFFECT** |

上述每个 seam 只有一个 owner。provider 可以是多个事实源，但不存在 provider 与 consumer 各自实现半套 authority 的安排。

## E. 循环依赖检查

依赖方向统一为“外部权威/公共地基 → #543 consumer → status/event/audit”，没有反向要求外部 RFC 消费 #543 的私有表或状态机。

1. RFC-2 提供 pinned definition/public projection；#543 assembly、binding resolver 与 evaluator消费它。RFC-2 不依赖 #543 runtime binding 可用性完成 compile，故无环。
2. RFC-1 提供 closure/join/reopen authority；#543 只提交 typed decision并消费 typed outcome。RFC-1 不读取 #543 journal作为自身 legality、claim、budget或cursor authority，故无环。
3. subprocess primitive只提供过程事实；journal赋予领域identity与恢复语义；adapter不把journal领域类型反灌进primitive，故无环。
4. execution terminal先于diagnostic派生；observer matcher排除`hook.*`，event不会反向启动自身，故无自激环。
5. operator mutation产生的correction/binding事实进入后续evaluation；decision stdout不直接执行mutation，scoped CLI replay也不等待同一decision terminal，故无事务闭环。
6. metadata mutation只保存current-state结果；journal不从旧metadata重建authority，过渡兼容不形成双向同步，故无迁移环。

循环依赖：**0**。双 owner seam：**0**。未指定 owner seam：**0**。

## F. 现场就绪边界

以下只陈述能力事实是否足够，不拆 issue、不安排实现顺序：

- **事实已足够用于消费设计：** 外部 effect 不兜底；observer 全并发；operator-only mutation边界；SQLite局部事务底料；三词 decision语义；八个 gate point与四层合成语义；`shutdown-held` admission结果；旧 keep-active carrier不得成为新authority。
- **已有修补后合同、但尚须取得 runtime 资格：** async subprocess primitive；durable delivery/execution；fixed payload assembly；evaluation journal/recovery；metadata current-state mutation；terminal→diagnostic派生；evaluation-scoped mutation replay。
- **被 RFC-2 阻塞：** pinned definition resolver/public compile projection、named declaration的可分发typed shape、script join additive typed variant，以及所有要求source漂移后仍复现旧payload/resolution的完成主张。
- **被 RFC-1 阻塞：** closure六边真实trigger/identity/snapshot、join-ready与canonical host-target facts、correction claim、target legality、cursor、budget、原子reopen effect及terminal/lifecycle preservation。
- **不构成 blocker：** 文件、Git、数据库、第三方服务的幂等、锁与冲突处理；这些由脚本作者和目标系统承担，不回流为#543机制需求。

局部 observer、gate 或 binding proof 不能越过上述 blocker 外推为 RFC 完成；同样，外部 blocker 不阻止不依赖其权威事实的 #543 consumer 接缝被单独证明。

## G. 尾部核对

- [x] 五份需求报告的 133 个原子 ID 全部唯一映射；未映射 0。
- [x] 分类只使用：直接复用、修补后复用、过渡兼容、消费能力自建、地基仍缺。
- [x] 11 个交叠 seam 均有唯一 owner、provider、consumer、原子合同与 blocker。
- [x] subprocess、pinned payload、四层 identity、decision ADT/typed ingress、journal/recovery、operator mutation/audit、metadata current-state mutation、hook diagnostic、named binding、closure transition、closure/reopen authority全部覆盖。
- [x] 外部 blocker保持 RFC-1/RFC-2 owner；未转化为#543替代实现。
- [x] 循环依赖 0；双 owner 0；未指定 owner 0。
- [x] 未读源码、未实验、未修改其他文件、未创建 worktree、未实现代码、未重拆 issue或安排实现顺序。

