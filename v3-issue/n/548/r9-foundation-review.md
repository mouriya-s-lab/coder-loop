# RFC #548 · R9 foundation 独立复核

## A. 摘要（≤1页）

**结论：PASS。**

当前 `AGG-548.md`、`expected-foundation.md` 与 `operator-decisions.md` 已通过完整 R9 gate：

- D1–D11 的每项确定含义均完整进入 AGG 的稳定条款、交付标准/LOG、事实或未证明项，并逐行进入 expected foundation；未发现弱化、扩大或误译。
- schema 载体二选一、projection 冒充 schema、creation-only gate、engine 零新增义务/现有 events 足够、duplicate payload/operation identity、空 chain 自动恢复/清理、preset-only 误判整份 `extra`、全历史扫描及非原子 repair 等旧预裁均已清除。
- T7 保持 current per-closure authority 为唯一 lifecycle authority；历史 slot/item owner 不恢复；probe-only、zero-spawn、`invocation_pending` 均不是 production completion。
- B-ET-1～6 全部保持为事实/外部合约阻塞。AGG 只保留不依赖未知 wire 的领域边界与条件式验收，没有反向规定 production binary、readiness 子命令/退出码、status producer、session/resume、endpoint identity、loss winner 或 candidate 结果。
- 三份文档当前结论一致；旧裁决账本中的过期“尚未裁决”、全持久历史量词和逐字段 repair 选项均已直接替换。

无阻断问题，无需再修正文档。

---

## B. 逐项对照与 path:line 证据

### B1. D1–D11 完整性

| 裁决 | AGG 证据 | expected foundation 证据 | 结果 |
|---|---|---|---|
| D1 CLI 输出真正 JSON Schema；projection 身份分离；可版本校验并派生类型 | `AGG-548.md:38,55,101,103,108,254-255,269` | `expected-foundation.md:9,25,33` | PASS |
| D2 field object 内逐字段 required；旧字符串/对象默认 required；optional 显式 false | `AGG-548.md:38,102` | `expected-foundation.md:10` | PASS |
| D3 全部改变 `extra` 的写入口守住可执行 item 持久态 | `AGG-548.md:55,97,104,256` | `expected-foundation.md:11,26` | PASS |
| D4 CLI 独立、无损、穷尽 typed rejection ADT | `AGG-548.md:105,109,230` | `expected-foundation.md:12,33` | PASS |
| D5 `(chain,itemId)` 是规范工作身份，不比较 payload/operation identity | `AGG-548.md:56,115,119` | `expected-foundation.md:13,28` | PASS |
| D6 空 active chain 长期合法，不补种、不删除、不承载 delivery verdict | `AGG-548.md:56,120,138` | `expected-foundation.md:14,28` | PASS |
| D7 engine durable request record；稳定 identity/typed verdict；明确 mutation durability；events 不冒充 | `AGG-548.md:139,229-230,318,334` | `expected-foundation.md:15,28,35` | PASS |
| D8 engine/preset 两个权威子模型合成完整严格 `extra` schema，表达可写性 | `AGG-548.md:38,55,101,104,255-256,319` | `expected-foundation.md:16,25` | PASS |
| D9 startup 核对纳入范围的历史 item；非法者 durable 不可启动、零 spawn；专用修复 | `AGG-548.md:97,106,110` | `expected-foundation.md:17,34` | PASS |
| D10 仅可能再次执行 item；terminal/deleted 保留快照；重入先 gate | `AGG-548.md:97,106,110,256` | `expected-foundation.md:18,26` | PASS |
| D11 原子替换目标现存 preset + 完整 `extra` + 调度资格；失败无半状态 | `AGG-548.md:107,111` | `expected-foundation.md:19,27` | PASS |

裁决账本本身也已收敛：

- D1/D2 旧“尚未裁决”已替换为关联裁决（`operator-decisions.md:13,35`）。
- D3 量词明确限定为所有可执行 item，归档快照例外与重入 gate 同时写明（`operator-decisions.md:42-46`）。
- D7 明确 existing JSONL 不满足 durable record（`operator-decisions.md:84-89`）。
- D9 的扫描与 repair 未决项已由 D10/D11 的关联裁决替换，且明确不提供逐字段修复（`operator-decisions.md:105-113`）。
- D10/D11 分别固定扫描量词和原子边界（`operator-decisions.md:118-124,129-136`）。

### B2. 旧预裁零残留 gate

| 旧预裁 | 当前证据 | 结果 |
|---|---|---|
| schema 载体仍二选一 / compile projection 冒充 schema | AGG 明确 CLI JSON Schema、projection 不承担 schema 身份（`AGG-548.md:101,108,269`）；依赖图也已改成 authoritative model → CLI JSON Schema（`AGG-548.md:287`） | PASS |
| 只守创建期 | add、batch-add、所有 `extra` 更新、startup/repair/re-entry 全部用同一 gate（`AGG-548.md:55,104,106-111,256,287`） | PASS |
| engine 零新增义务 / 现有 events 覆盖审计 | durable request record 为明确新增义务，events 仅窄互证（`AGG-548.md:139,229-230,240,318,334`） | PASS |
| duplicate 需 payload/operation identity | 明确不比较、不新增（`AGG-548.md:119`; `operator-decisions.md:64`） | PASS |
| 空 chain 归 recovery/cleanup | 明确不自动补种/删除，verdict 另有记录（`AGG-548.md:120`; `operator-decisions.md:73-79`） | PASS |
| 对旧整份 `extra` 只按 preset schema 判断 | 完整 schema 由 engine/preset 子模型合成；历史混合 shape 是既有事实（`AGG-548.md:101,319`; `expected-foundation.md:16`） | PASS |
| daemon 启动扫描全历史 item | 仅 active/stopped/可 resume/retry；terminal/deleted 是快照（`AGG-548.md:106`; `expected-foundation.md:18`） | PASS |
| repair 逐字段或非原子 | 完整 preset + `extra` + 资格单事务语义（`AGG-548.md:107,111`; `operator-decisions.md:129-136`） | PASS |

### B3. T7 authority、zero-spawn 与六项 blocker

**唯一 authority：PASS。**

- AGG 的协议、authority、交付边界分别写明 unknown external contract、current per-closure 唯一 owner，以及真实 invocation 才构成交付（`AGG-548.md:72-76`）。
- T7 再次明确 closure/run/worktree/session/reachability/consumption/cleanup 是唯一事实源，历史 slot/item owner 不得恢复（`AGG-548.md:152-156,168`）。
- expected foundation 将 current authority 写为已知边界，同时明确它不能证明 remote lifecycle（`expected-foundation.md:20,29`）。

**zero-spawn 非交付：PASS。**

- `probe-only`、zero-spawn、`invocation_pending` 被明确排除于 production completion（`AGG-548.md:76,154,171,199-203`; `expected-foundation.md:21,29`）。

**B-ET-1～6 未升格：PASS。**

- AGG 明示只固定不依赖未知 wire 的领域边界，不能由本文反向规定外部合约（`AGG-548.md:160-162`）。
- 六项 blocker 完整逐项保留：binary/readiness、headless status/session、endpoint identity、terminal/loss winner、真实 E2E、frozen candidate gate（`AGG-548.md:173-182`），与原输入 `decision-external-terminal.md:15-26` 一一对应。
- 条件式验收只有在 B-ET-1～4 成为事实后才能执行，且禁止反向定义子命令、固定退出码、status producer、session identity 或 endpoint key（`AGG-548.md:184-186`）。
- 完成证据禁区和验证边界继续拒绝 fake、current authority 替代、未冻结 candidate 和 stdout 私有响应（`AGG-548.md:199-214`）。
- expected foundation 将六项全部保留在未证明清单（`expected-foundation.md:37-41`）。

### B4. 文档内部一致性、范围与依赖

- T2 的稳定条款、STD、LOG、依赖 C1–C3 和依赖图使用同一最终含义（`AGG-548.md:95-111,229-230,254-256,287`）。
- T3/T5 对规范 identity、空 chain、verdict 与 durable request record 的边界一致（`AGG-548.md:113-120,132-140`）。
- T7 的稳定目标、blocker、条件式验收、禁用证据和验证边界顺序一致，没有让验收表反向生成需求（`AGG-548.md:160-214`）。
- 外部 runner 合约被登记为待满足依赖 C8，而不是当前保证（`AGG-548.md:261`）；Q3 继续保持事实阻塞（`AGG-548.md:347`）。
- AGG 没有把 D1–D11 扩为 GitHub 内建知识；引擎改动被限定为已裁保证，GitHub 映射仍归外挂（`AGG-548.md:149,240-241`）。
- expected foundation 明确不定义实现方案、issue 边界或工作量（`expected-foundation.md:3`），其正文也未出现此类扩张。

### B5. expected-foundation 逐行闭合

| 行段 | 结果 |
|---|---|
| `expected-foundation.md:9-19` | D1–D11 每行均含稳定条款、实然问题、裁决、预期保证、未证明运行项；PASS |
| `expected-foundation.md:20-21` | closure authority 与真实 remote completion 边界明确；六 blocker 未变成保证；PASS |
| `expected-foundation.md:23-29` | 五项不变量准确汇总公共契约、持久态、原子修复、request record 与 closure authority；PASS |
| `expected-foundation.md:31-41` | 运行清单覆盖 schema、startup/repair、request record、delivery E2E 及 B-ET-1～6；PASS |
| `expected-foundation.md:43-51` | 证据索引能回到操作员裁决、历史 DB 事实、external decision 与 R7 authority；PASS |
| `expected-foundation.md:53-58` | 自检与正文一致；PASS |

## 报告核对

- 本轮重新只读当前 `AGG-548.md`、`expected-foundation.md`、`operator-decisions.md` 及原决策/R7 输入，复跑完整 gate。
- 除直接替换本报告外，未修改其他文件。
- 未创建 worktree、issue、PR，未实现或重拆。
- 结论：**PASS；无剩余阻断。**
