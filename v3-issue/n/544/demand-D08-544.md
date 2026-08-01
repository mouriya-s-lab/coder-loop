# RFC #544 R10 / D8 — F 档控制面与 mutation 收口原子需求

> 输入边界：只读 AGG D8/F 档、`expected-foundation-544.md` 与 S6/S7 纠偏摘要。本报告不读取源码、旧 issue 或实现，不拆 implementation issue。D8 负责 GUI/gateway 的 exact F façade、动作可达与结果呈现；领域合法性仍由 daemon 与 CAP-4 裁决。

## A. 主 agent 摘要

D8 的 mutation surface 必须是编译期封闭的 F 档，恰好包含：

- daemon start / stop / restart；
- `queue.unblock`；
- `chain.stop` / `chain.resume`；
- `item.reorder`；
- 对指定 evaluation epoch 的 capability query，以及 capability 允许时的 `advance | hold | reopen` decision。

其中 daemon start 是唯一非 RPC 动作：gateway 按 D7/F10 spawn `coder-loop daemon up`，进程与 gateway 解耦。stop/restart 和其余 socket mutations 才进入单一 typed mutation client。F façade 必须从引擎 command/args/result/error 与 CAP-4 ADT 派生，不能暴露 daemon 的任意完整命令集；`chain.create`、`item.add`、batch 等创建类入口在类型、route 与 UI 中均不可达。

gateway 只按既定 operator 主体转发。所有 socket mutations 经 daemon admission/domain handler 裁决；gateway/frontend 不复制 target、authority、capability、currentness 或状态转移规则。CAP-4 query 返回当前 operator 对指定 `(parId, epoch, bindingVersion)` 的 capability；无 capability 时只显示 authority 缺口，不能用 resume、unblock 或改 join 冒充 decision。

每个 socket verb 的结果必须是精确 ADT：`accepted`、`rejected`、`failed`。已知拒绝或执行失败不能序列化为成功；transport timeout/断连导致的未知结果也不能冒充 daemon rejection。四个既有 verb 的核心状态改变由 status/events 核验；CAP-4 还必须由真实 evaluator 消费，并让 status、event、audit 对齐同一 evaluation identity、operator 与 decision。核验是多个事实面的对照，不要求跨 SQLite/events/audit 的共同 commit。

D8 不重建 operator 认证、不全面封锁 store，也不要求 durable operation identity、query/replay、outbox、saga、command log、known-outcome 或 exactly-once。mutation audit event 由 daemon/CAP-4 供给，gateway 没有第二日志义务。

### A1. 结论计数

| 分类 | 数量 | 结论 |
|---|---:|---|
| D8 必须自建的原子保证 | 11 | exact F ADT、单 typed client、start 分流、UI 可达、创建类不可达、纯转发、结果 ADT、四 verb 核验、CAP-4 gating/submit/呈现 |
| 预期地基已供的保证 | 12 | F03–F05、F07–F10、F11、F15、F25–F30 中由 D8 直接消费的 12 组供给 |
| 真正地基未闭合 | 0 | U07/U14/U15 是专项验证输入，不生成新机制 |
| 非阻塞运行未知 | 3 | U07、U14、U15 |
| 明确排除的范围增长 | 8 | 认证重构、全面封 store、durable operation、replay、outbox/saga/log、共同 commit、第二审计日志、exactly-once |

## B. 原子需求矩阵

### B1. D8 自建保证

| ID | 原子保证 | D8 必须成立的语义 | 地基映射 | 可证伪验收 |
|---|---|---|---|---|
| **D8-R01** | exact F operation ADT | GUI mutation type 穷尽表达 F 档且仅表达 F 档；新增 daemon command 不会自动进入 GUI | F25、X06 | exhaustive dispatch 覆盖所有 F variant；范围外 command 不能构造 |
| **D8-R02** | 单一 typed mutation client | 所有 socket mutation 经一个 engine-derived façade；前端无裸 socket、宽 command 或第二 framing/parser | F07–F09、F25 | 全树写入口只能到 façade；错 id、invalid response、timeout 与 remote rejection 保持 typed |
| **D8-R03** | daemon start 非 RPC 分流 | `daemon.start` variant 由 gateway spawn `coder-loop daemon up`；不进入 socket client，spawn daemon 生命周期与 gateway 解耦 | F10、F26 | daemon 死态可 start；gateway 退出不带走 daemon；代码中不存在 start RPC |
| **D8-R04** | stop/restart 与 socket mutations 归 daemon | daemon stop/restart、四 verb 与 CAP-4 submit 通过 typed socket client，由 daemon 裁决 | F26 | gateway 不在副作用前自裁；daemon 的 typed accept/reject/failure 原样呈现 |
| **D8-R05** | 对象视图动作可达 | unblock、chain stop/resume、item reorder 在对应对象视图可触达；daemon lifecycle 在活性视图可触达 | F25、F27 | 浏览器逐项遍历 F 入口，四 verb 均对真实对象执行 |
| **D8-R06** | 创建类与任意命令不可达 | 不存在 `chain.create`、`item.add`、batch 或任意 daemon command 的 UI、route、client method 与动态字符串逃逸 | F25 | 类型/API/UI 三面搜索与运行遍历均只有 F 档 |
| **D8-R07** | gateway 纯转发 | args/result/error 从引擎/CAP-4 boundary 派生；gateway 不复制 target、authority、capability/currentness 或领域合法性判断 | F25、F26、F28、F29 | 同一非法请求只由 daemon 给出领域拒绝；gateway 仅处理 transport/boundary |
| **D8-R08** | accepted/rejected/failed 穷尽呈现 | 每个 socket verb 至少区分 daemon accepted、明确 rejected、执行 failed；transport 未确定结果保持独立，不静默吞错 | F07–F09、F27、F29 | daemon-down、invalid target、handler failure 与成功分别得到不同 UI/result variant |
| **D8-R09** | 四 verb 最小结果核验 | unblock、stop、resume、reorder 成功后的核心状态由 canonical status 读回，相关事件可用于诊断/核验；不要求跨介质原子 | F03–F05、F11、F15、F27、X03 | 四动作逐项执行后 status 显示目标状态/顺序，事件身份可关联 |
| **D8-R10** | CAP-4 capability-gated decision | GUI 对指定 evaluation identity 查询当前 operator capability；仅显示允许的 `advance|hold|reopen`；无 capability 显示 authority 缺口 | F28、F29 | capable/无 capability/stale identity 三种路径分别正确，不能以其他 F 动作替代 |
| **D8-R11** | CAP-4 submit 与同源观测 | decision 经 F typed operation 提交；accepted 后由 evaluator 真实消费，status/event/audit 对齐 identity、binding version、operator、decision；UI 不拼装事实 | F28–F30、X01、X03、X06 | 三 decision 各有真实路径；观测面引用同一 identity，authority 缺口不伪装为 decision |

### B2. 预期地基已供

| ID | 已供保证 | D8 消费方式 | 不得重造 |
|---|---|---|---|
| **D8-F01** | F03–F05 canonical status snapshot/wire | R09/R11 核验动作与 CAP-4 projection | GUI 平行状态推断或 schema |
| **D8-F02** | F07 typed client 有界完成并销毁 socket | R02/R08 处理 deadline/cancel | 外层 race、server cap 前提 |
| **D8-F03** | F08 request/response identity 严格匹配 | mutation response 归属到具体 operation | 任意非空 id 成功 |
| **D8-F04** | F09 command→args→result/error 精确闭集 | F façade 从 engine boundary 派生 | gateway 字符串表、宽 JSON command |
| **D8-F05** | F10 daemon lifecycle 机制 | R03 对 start 做非 RPC spawn；stop/restart 用既定机制 | 通用 supervisor 或 gateway-owned daemon |
| **D8-F06** | F11/F15 events 与死因/异常可见通道 | R09/R11 关联动作结果与诊断 | replay、跨流全序或第二日志 |
| **D8-F07** | F25 exact GUI mutation surface | R01/R05/R06 形成编译期闭集 | 暴露服务端全部 command |
| **D8-F08** | F26 operator 主体、socket mutation 由 daemon 裁判 | R04/R07 只转发 | 认证重构、peer/token、全面封 store |
| **D8-F09** | F27 四 verb 的 accepted/rejected/failed 与核验 | R08/R09 映射具体 UI 与对象视图 | durable operation、共同 commit |
| **D8-F10** | F28 evaluation identity 与 decision ADT | R10/R11 使用 `(parId,epoch,bindingVersion)` 与三分 decision | resume/unblock/join 替代 |
| **D8-F11** | F29 capability query、typed submit、daemon currentness 校验 | R10/R11 接入同一 F façade | 第二授权系统 |
| **D8-F12** | F30 evaluator consumer 与 status/event/audit 对齐 | R11 呈现同源观测 | exactly-once、全局 sequencer |

### B3. 四 verb 最小语义

| Verb | accepted 后必须可见 | rejected | failed | 核验面 |
|---|---|---|---|---|
| `queue.unblock` | item 离开 blocked 语义，相关 current 状态按领域结果可读 | target 不存在或 not-unblockable 等领域拒绝 | handler/store 执行失败 | status queue/current + events |
| `chain.stop` | chain 显示 stopped；相关 active run 变化按领域结果可读 | target/状态不允许 | handler/process/store 失败 | status chain/current + stop/status events |
| `chain.resume` | chain 显示 active；不额外承诺同步 spawn child | target/状态不允许 | handler/store/scheduler trigger 失败 | status chain + resume/status events |
| `item.reorder` | queue 最终顺序与 accepted args 一致 | 非法 target/order 在副作用前拒绝 | transaction/handler 失败 | status queue + reordered/admission events |

### B4. CAP-4 最小语义

| 面 | 已供 | D8 责任 | 不得混同 |
|---|---|---|---|
| identity | F28：`parId+epoch` 关联 binding version | route/UI 携带完整 identity，不按 latest 猜 | lifecycle `decided` 字符串不等于 decision |
| capability | F29：当前 operator 对指定 evaluation 的合法动作 | query 后只呈现允许动作；submit 仍接受 daemon 重验 | capability 不授予其他 F 动作 |
| decision | `advance|hold|reopen` 封闭 ADT | typed submit，不用其他 mutation 冒充 | reopen count/join mutation 不是 decision |
| result | F29：accepted/rejected/failed | 领域/transport variant 明确展示 | timeout 不等于 rejected 或未提交 |
| consumption | F30：evaluator 真实消费 | 页面核验领域结果 | audit event 不自动证明消费 |
| observability | F30：status/event/audit 同 identity/operator/decision | 只渲染供方事实，不拼装第二事实源 | 不要求三介质共同 commit |

### B5. 供需归属与未闭合判断

| 需求面 | 预期地基已供 | D8 自建 | 真正地基未闭合 |
|---|---|---|---|
| F 范围 | F25 | exact ADT、UI/route/client 不可逃逸 | 无 |
| transport | F07–F09 | 单 mutation client 与 UI error mapping | 无 |
| lifecycle | F10/F26 | start 非 RPC 分流、其余动作接线 | 无 |
| operator/admission | F26 | 纯转发与 daemon 结果呈现 | 无 |
| 四 verb | F27 | 对象视图、逐 verb 执行与核验 | 无 |
| CAP-4 | F28–F30 | capability UI、typed submit、同源展示 | 无 |
| observability | F03–F05、F11/F15、X01/X03 | 多面核验而非平行事实源 | 无 |

### B6. 非阻塞运行未知

| 未知 | D8 验证影响 | 不得推出 |
|---|---|---|
| **U07** mutation 已提交但 response 丢失频率与失败窗口 | accepted/rejected/failed/transport-unknown 的 fixture 与文案 | durable operation identity、query/replay |
| **U14** 四 verb 与三 decision 的真实浏览器/status/events/audit 路径 | D8 专项 E2E 覆盖矩阵 | 共同 commit、outbox/saga 或 exactly-once |
| **U15** daemon lifecycle 本机/浏览器路径 | start 非 RPC、stop/restart 与三证闭环验证 | 通用 supervisor 或 start RPC |

### B7. 明确排除

1. 不重构 operator 认证，不引入 peer/token/session 第二授权系统。
2. 不要求全面封锁 store、迁移内部 scheduler/maintenance 写入口或证明所有本地 caller 身份。
3. 不建立 durable operation identity、operation status/query 或 known-outcome 平台。
4. 不要求 timeout/断连后的 mutation replay 或幂等重放协议。
5. 不引入 outbox、saga、command log 或通用 recovery framework。
6. 不要求 SQLite、events、audit 与 response 的 common commit 或跨介质原子事务。
7. 不为 CAP-4 建第二审计日志、全局 sequencer 或平行 authority 系统。
8. 不要求 exactly-once；只要求稳定文本中的真实消费与同 identity 可核验。

### B8. R11 接缝

| 接缝 | 供方 | D8 消费点 | 固定边界 |
|---|---|---|---|
| typed transport | F07–F09 | R02/R08 | transport failure 精确；无第二 parser |
| daemon lifecycle | F10/F26 | R03/R04 | start 非 RPC；socket mutation 才归 daemon |
| four verbs | F27 | R05/R08/R09 | 逐 verb 最小结果与 status/events 核验 |
| CAP-4 | F28–F30 | R10/R11 | capability → typed decision → consumer →同源观测 |
| status/events/audit | F03–F05、F11/F15、F30 | R09/R11 | 独立数据面核验，不生成共同 commit |

