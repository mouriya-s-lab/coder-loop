# `.writing-rfc-543/article.md` 最终验收

## Verdict

**PASS。**

润色后的 `article.md` 保留了通过复审的全部机制、因果链和责任边界。润色主要增加章节间的追问连接、消除局部生硬表达，并未重新引入旧文档句法、删成概要、改变 current/target/blocker 关系或加入新的产品事实。

## 最终验收结果

### 1. 未重新引入照抄

针对 `03-implementation-status.md`、`23-expected-foundation.md` 和 `SYNTH-543-hook-observability-gate.md` 重新进行连续文本比对：

- 上轮要求独立重述的 observer outcome、固定 payload、RFC-1 reopen 递交边界、`shutdown-held` 准入四处仍保持独立表达；
- 剩余较长共同片段仅是固定合同名、ADT 或验证项名称，例如 `pinned definition artifact/resolver`、`snapshot 与 transition identity`、`evaluating | decided | consumed`、`spawn/ownership kill-point`；
- 没有发现沿旧文档章节顺序、矩阵字段顺序或 child issue 顺序逐项改写的结构。

**疑似照抄：0 处。**

### 2. 未压缩成概要

`article.md` 与通过复审的 `draft.md` 均为 127 行，十二个主体章节全部保留。润色没有删除机制论证，反而在章节入口补上了相邻问题之间的逻辑接缝，例如：

- observer/gate 分离之后为什么还要解决声明治理；
- process ownership 为什么不能替代固定输入；
- typed decision 为什么不能替代 crash journal；
- evaluator 为什么还需要具名 binding；
- join 为什么是判定协议必须接入的调度接缝；
- 可恢复为什么不等于引擎接管外部世界。

全文仍然是问题—失败—机制—责任的展开，不是特性列表、执行摘要或 closing checklist。

### 3. 十二节与核心论点完整

十二节依次保留并承担独立论证责任：

1. 策略外置与调度权威的问题边界；
2. event log / agent phase 不足；
3. 四层声明治理；
4. observer 进程所有权；
5. pinned/versioned payload；
6. gate typed decision 与合成；
7. 四层 identity、journal、epoch、fingerprint；
8. 具名 gate binding；
9. script join 与 RFC-1 reopen authority；
10. 统一 observability 与零自反；
11. 并发、外部 effect、`shutdown-held` 与 external blockers；
12. 组合边界为何构成 RFC 的价值。

结论仍可从正文推出：可靠性来自引擎自有状态的可恢复性与明确的权威分工，而不是把所有脚本副作用吸入引擎事务。

### 4. current main、目标合同和 blocker 仍然分离

- `article.md:11` 只把声明 ADT、四层形状、operator-only 持久化语义及局部先例归给 current main，并明确 observer/gate 执行闭环尚未形成；
- `article.md:11` 同时定义后文“RFC 实现”为目标协议与修补后合同，没有冒充已落地事实；
- `article.md:117` 把 RFC-1/RFC-2 三组供给标为 external blockers，并明确缺失只阻塞相应 completion claim，不授权 #543 建替代 authority；
- `article.md:119` 把 expected contract 与 runtime proof 再次分开，没有把静态 ADT 或局部事务先例外推为跨重启验证。

润色新增的 expected foundation / external blocker 括注只是解释文中术语，没有改变依赖或新增状态事实。

### 5. 四层 identity 保持准确

`article.md:67` 仍完整区分 transition、delivery、execution、evaluation identity，并用一对多关系说明它们不可互代；epoch 与 fingerprint 仍被限定为 evaluation 的代次与输入维度。`article.md:95` 保留从 RFC-1 transition identity 派生 observer delivery 的方向，并禁止用 delivery identity 反向冒充生命周期边去重依据。

没有重新出现 execution/attempt 同义混列，也没有把 epoch/fingerprint 抬升为同级身份。

### 6. `shutdown-held` 因果链保持完整

`article.md:113` 仍从 held 收敛阶段的待排空集合必须停止增长出发，说明继续接受 mutation、scheduler work 或 observer delivery 会使 drain 无法收敛，并让存储关闭与新 intent 提交竞态，造成 accepted work 没有 durable outcome。

同段保留 query 可用的独立理由：operator 需要定位 hold、观察 drain 和取得解除事实。`article.md:115` 再推出 typed reject、accepted work drain、拒绝无 DB/event/spawn 副作用以及调用方负责重提。规则、失败和责任完整闭合。

### 7. 无新事实或实现预裁

相较 `draft.md`，新增内容是过渡句、术语解释和语法润色，没有新增：

- schema、表、列、队列、锁、outbox 或 consumer 拓扑；
- 新 decision variant、gate point、身份层或重试保证；
- 新 external blocker、issue 拆分或 completion evidence；
- 引擎对文件、Git、数据库或第三方服务的额外兜底责任。

原有非保证仍成立：observer/gate 判定主体不承诺 exactly-once，外部副作用由脚本作者协调，#543 不替代 RFC-1/RFC-2 authority。

## Gate matrix

| 验收门 | 结论 |
|---|---|
| 润色未重新引入照抄 | PASS |
| 未压缩成概要 | PASS |
| 十二节齐全、论点完整 | PASS |
| current / target / blocker 分离 | PASS |
| 四层 identity 保留且准确 | PASS |
| `shutdown-held` 因果链保留 | PASS |
| observer/gate、声明、payload、process、journal、binding、join/reopen、observability、effect 边界完整 | PASS |
| 无来源新需求或实现预裁 | PASS |
| 结论可由正文推导 | PASS |

## 最终统计

- Verdict：**PASS**
- Open findings：**0**
- 疑似照抄：**0 处**
- 核心遗漏：**0 处**
- 十二节完整性：**12/12**
- 润色引入的新事实：**0**
