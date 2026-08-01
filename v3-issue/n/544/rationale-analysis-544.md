# RFC #544 问题与理由分析：从运维失明到可处置的观测面

> 本文只回答“为什么需要这些能力、它们共同消除什么问题”。它不按既有交付物编号复述方案，也不提供实现步骤。方括号索引指向文末事实来源，供主 agent 逐项核验。

## 一、原始问题不是“缺一个网页”，而是操作员无法独立判断系统事实

coder-loop 已经把执行移入长期运行的 daemon，但操作员要知道一次工作是否仍在推进，仍需让 agent 寻找 session、翻日志并解释局部现象。这个过程把本应直接可见的运行事实变成了一次新的代理调查：调查者可能找错 session、只看到某个 attempt、把陈旧 pid 或 socket 当成活性证据，也无法在 daemon 已死时询问 daemon 本身。用户要解决的核心问题因此不是页面美化，而是获得一个不依赖 agent 代查、能在几秒内回答“正在运行、卡在哪里、为什么停、刚才发生了什么”的操作员视图。[E01][E02]

现有系统并非没有数据。持久状态、事件、daemon 状态以及跨 chain/item/run/phase 的关联键已经存在；缺失的是把这些事实以网络可达、持续更新、可钻取的方式交给人，并保持它们各自的来源语义。若只是把 CLI 输出包进网页，陈旧活性、宽松 status 形状、轮询成本和 daemon-down 失明会原样进入 GUI。GUI 的价值必须来自更可靠的判断链，而不能来自视觉包装。[E02][E03][E04]

这也解释了为何“看一眼”并不等于显示一个绿色圆点。daemon 的进程、socket 可连接性和 RPC 应答曾出现分裂；pid 与 socket 文件也可能只是残留。单一 `running` 值会掩盖最需要诊断的中间态。可靠首屏必须保留彼此独立的证据，并把活跃工作、最近转移、限流状态和异常事件放在同一决策上下文中；否则操作员仍要离开页面做第二轮调查。[E01][E02][E05]

## 二、观测面必须与被观测者分离

daemon 不健康时，观测需求反而最高：需要知道最后一个可靠状态、死亡前事件和可能的死因，并决定是否拉起它。若 HTTP 服务内嵌 daemon，故障会同时带走被观察对象和观察入口，页面失联既可能表示 daemon 死亡，也可能只是网络断开，用户无法区分。独立 gateway 的理由是打断这一共同失效关系，使“daemon 已死但观测面仍活”成为正常状态，而不是异常旁路。[E06][E07]

独立进程还把恢复闭环放在正确的故障域。daemon 没有 socket 时，恢复不可能依靠向该 socket 发送 start 请求；gateway 必须能从 daemon 外部发起启动，并在之后用多项活性证据确认恢复。反过来，gateway 的退出也不能带走已启动的 daemon，否则两者仍形成隐蔽的生命周期耦合。这里需要的是故障域分离，而不是再造一个通用 supervisor：自动守护、重启策略和进程平台都超出了“人看见后处置”的问题范围。[E06][E08][E20]

分离并不意味着建立新的真相源。gateway 是消费与转发边界：它不取得 SQLite 写权，不重演 scheduler，不从 worktree、git 或进程痕迹推断任务状态，也不拥有 mutation 合法性。它若自行解释领域状态，会让“观测面独立”滑向“第二个控制器”，产生比原有失明更难发现的事实分叉。[E09][E10]

## 三、三类事实必须走三条数据面，因为它们的存活条件不同

一个统一的 daemon RPC 看似简单，却无法满足 daemon-down 场景；让 gateway 直接读所有文件又会绕过 daemon 的写入裁决。合理边界来自数据本身的职责，而非为了技术整齐强行合并。

**持久任务状态**回答“队列、chain、task tree 最后处于什么状态”。它在 daemon 停止后仍有价值，因此需要严格只读的 SQLite 读取路径。严格只读不是性能偏好，而是观测可信度：读者若能切 journal mode、触发 migration 或改变 sidecar 元数据，就可能在诊断现场修改证据，甚至在 writer 缺席时改变未来恢复条件。读取失败也必须区分缺盘、权限、损坏和不兼容 schema；把它们都显示成“没有状态”，会把基础设施故障伪装成空系统。[E11][E12]

**过程事件**回答“发生过什么、哪里出错、最后推进到哪”。它们必须在 daemon 死后继续可查询，已打开的浏览器通道也不应随 daemon 消失，所以历史和增量推送不能依赖 daemon socket subscription。events JSONL 已有同仓导出契约、稳定关联键与轮转规则，gateway 作为唯一特许消费者可沿该契约读取；这项豁免成立的条件正是 gateway 与引擎同仓同版本演进，不能扩散成脚本普遍刮 runtime 文件的先例。[E03][E06][E13]

**瞬时控制与 mutation**回答“现在能否与 daemon 对话、请求是否获准、动作结果是什么”。这部分必须经 socket RPC，因为 daemon 才拥有当前准入、状态转移和写入所有权。gateway 只将精确 typed 请求转发并呈现接受、拒绝、失败或传输未确定结果，不能直写 SQLite，也不能提前复制一套合法性判断。[E09][E14]

三面并置不表示它们共享一个全局时钟。SQLite snapshot、进程探针和事件文件各有采样时点；GUI 应呈现来源与时间，而不是合成一个无法证明的原子世界状态。这样做消除的是来源混淆，而不是追求跨介质事务。共同 commit、全局 sequencer、outbox 或 exactly-once 都不是可靠观测所必需的前提。[E10][E20]

## 四、展示 prompt 是为了恢复“agent 实际收到什么”这一关键因果证据

当 attempt 失败、跑偏或在 resume 后行为异常时，仅知道 prompt 字符数没有诊断意义。真正需要核对的是当次传给 runner 的完整文本、每个变量当时解析出的值、这是 fresh 还是 resume，以及续接了哪个 session。当前渲染依赖一次性的 run identity 和当时 item 状态，事后拿现在的 preset 与现在的状态重新渲染，会产生一份看似合理但并非当时输入的文本。[E02][E15]

因此 prompt 视图的理由不是“方便阅读配置”，而是保存执行因果链的输入端。显示内容必须与 runner argv 的有效 prompt 同源，并绑定该 attempt 所属的 pinned definition；否则 preset 更新或 daemon 恢复后，历史页面会悄悄改写过去。历史 attempt 没有快照、或快照写入失败时，也必须如实显示不可得，而不能猜测、重建或留空让人误以为没有 prompt。[E15][E16]

这项观测辅助不能反向成为执行门槛。快照失败应留下诊断事实，但不应阻止 agent 运行；否则为了观察执行而引入的新文件写入会改变执行可用性。它也不要求把 prompt 正文塞进 status snapshot，独立 artifact route 更能保持运行状态与大文本证据的边界。[E15][E20]

## 五、任务树与层级钻取解决的是“局部事件没有系统语境”

平铺日志可以告诉人某事件发生，却不能说明它属于哪个 chain、哪个 item、哪次 run 和哪个 phase，更无法表达 v3 的 seq/par/join/reopen 关系。没有层级与树，操作员看到“某 attempt 退出”后仍需手工拼接身份，遇到并行分支或重新打开的 evaluation 时尤其容易把某个叶子状态误当成整体状态。[E03][E17]

任务树展示应是运行态 typed tree 的穷尽投影，而不是前端根据文件夹、进程或旧 slot 概念重建结构。其理由有两层：一是让事件能够回到其所属 run/item，让“异常”变成可追踪的因果路径；二是让新增节点 variant 在类型层暴露尚未渲染的缺口，避免 GUI 在模型演进后静默遗漏一种状态。可分享的层级 URL 则把诊断对象固定下来，减少“我看到的那一轮”这种身份歧义。[E09][E17][E19]

## 六、编译元信息必须展示，因为运行态只能说明“现在怎样”，不能说明“为何会这样”

运行快照与事件能够回答实例发生了什么，却不能独立解释 preset 定义允许哪些状态、phase 如何组织、变量从哪里进入。v3 把状态机判定建立在可计算类型上；如果这些定义只存在于机器可读编译产物中，人仍需阅读配置并在脑中模拟编译器，GUI 就没有真正缩短理解链路。[E01][E18]

状态图、phase 任务结构和变量类型流必须来自同一次 current name-based compile artifact，与 CLI 导出一致。GUI 的职责是让该产物可理解，而不是读取 TOML 后实现第二个编译器。这样既把定义态与运行态明确分面，又允许操作员对照“设计允许什么”和“实例发生了什么”；二者混为一谈会诱使前端从运行痕迹反推定义，或用当前定义伪装历史 pinned definition。[E18][E19]

这里的边界同样服务于收敛：本 RFC 不需要 historical-pinned 与 current+pinned 双视图，也不能自行决定 definition 的永久保留或 GC 规则。需求是预览当前可计算定义，并让 attempt 的历史输入另由 pinned artifact 证明。[E19][E20]

## 七、移动控制面的价值是缩短处置时间，而不是把全部 CLI 搬到手机

移动场景发生在操作员离开开发机时：收到异常线索后，需要先判断 daemon 与工作流状态，再完成少数解除阻塞或生命周期动作。PWA 与 NetBird mesh 让相同应用和相同 routes 在手机上可达，避免维护原生客户端、第二套 schema 或移动专用后端。首屏优先级也由这一场景决定：活性证据、active run、异常和动作要先于深层详情。[E01][E21]

写面限制为 F 档，是价值与风险共同推导的边界。daemon start/stop/restart、unblock、chain stop/resume、item reorder，以及有 capability 时的 per-epoch decision，都是“看见异常后恢复或解卡”的短交互；chain create、item add 与 batch 属于需要更多上下文和参数设计的创建工作，手机入口既不必要，也会扩大误操作和维护面。完整 CLI parity 并不会增强观测闭环，只会把 RFC 变成第二套运维产品。[E06][E14][E21]

CAP-4 decision 还必须由 capability 控制。页面只能展示 daemon 对指定 evaluation identity 返回的允许动作；没有 capability 时应呈现 authority gap，而不是用 unblock、resume 或修改 join 来伪装 decision。gateway 不推导 decision，也不建立第二套授权系统，因为领域裁决必须仍由 daemon 和 evaluator 拥有。[E14][E22]

mesh-only 且无应用层登录是既定信任模型的延续，不是安全功能缺失。监听面限定 loopback 与明确 NetBird interface，使网络成员资格成为准入边界；公网、LAN 通配监听、SSO 和 bearer token 都会改变威胁模型与运维面，当前问题并不要求它们。反过来，“无应用层鉴权”绝不等于监听 `0.0.0.0`：精确绑定是这一裁决成立的必要条件。[E06][E23]

## 八、必须被消除的失败模式

以下失败不是彼此独立的功能缺口，而是同一条“看到事实—理解原因—采取动作—确认结果”链上的断点：

1. **共同死亡**：daemon 崩溃同时带走观察入口，用户无法区分 daemon 死亡与网络故障。独立 gateway 与 daemon-down 可读面必须消除它。[E02][E06]
2. **假活与假死**：陈旧 pid/socket 或控制面分裂被折叠成单一状态。独立三证及其采样语义必须消除它。[E02][E05]
3. **观察改变现场**：status reader 在诊断时修改 SQLite journal、schema 或 sidecar。严格只读生命周期必须消除它。[E11][E12]
4. **错误被伪装为空状态**：损坏、权限或 schema 不兼容被压成 missing。精确 typed DB result 必须消除它。[E11]
5. **事件越积越慢且 daemon 死后不可看**：全量轮询和 daemon-bound subscription 无法提供持续观测。按契约增量读取与独立 SSE 宿主必须消除它。[E02][E13]
6. **单客户端断开击穿整个网关**：已实测的 SSE close/enqueue race 能让 Bun 进程退出。资源生命周期必须随 request abort 闭合；否则新观测面会复制 daemon 的单点失明。[E23]
7. **展示的输入并非实发输入**：事后重渲染或读取更新后的 preset 改写历史。attempt 同源 prompt/bindings 与 pinned identity 必须消除它。[E15][E16]
8. **局部事实失去身份**：事件、run、item 与树节点无法互相定位，par/join/reopen 被平铺视图吞掉。typed tree 与双向导航必须消除它。[E17]
9. **前端成为第二解释器**：复制 status shape、编译逻辑、command 表或 capability 规则，随后与 engine 漂移。全链路 ADT、边界 parse 与 producer-owned artifact 必须消除它。[E10][E18][E19]
10. **按钮成功替代领域成功**：toast 或 RPC 返回被当成动作已生效。结果必须区分 accepted/rejected/failed/transport-unknown，并由 canonical status/events/三证核验。[E08][E14]
11. **移动端写面蔓延**：为“方便”逐步加入创建类或任意 daemon command。编译期封闭的 F façade 与同应用同 routes 必须消除它。[E14][E21]
12. **无 authority 仍可决策**：页面猜 capability 或以其他 mutation 冒充 per-epoch decision。完整 evaluation identity、capability query 和 daemon 重验必须消除它。[E22]

## 九、需求理由、工程约束与范围外的分界

### 需求理由

必须让操作员不依赖 agent 代查即可判断运行与失败；daemon-down 时仍能观察和恢复；任何 attempt 的真实输入、任何事件的层级语境、运行态任务树以及当前可计算定义都可被人理解；手机上能完成有限的现场解卡。这些是用户痛点直接产生的结果要求。[E01][E07]

### 工程约束

独立进程、三数据面、严格只读、同仓 events 特许消费、engine-owned typed boundary、daemon 唯一 mutation 裁判、同一响应式 PWA、mesh 精确绑定，都是为了让上述结果在现有事实与信任模型下不自相矛盾。它们约束真相所有权与故障域，但不扩大产品目标。[E06][E09][E10][E23]

### 范围外

完整 CLI parity、原生移动应用、公众入口、LAN 通配监听、Keycloak/SSO/token、新的 agent/peer 身份体系、第三方 ingress、A 域资产格式化展示均不解决当前最短因果链。断线 replay、通用 history migration、crash journal、server/response caps、通用 process supervisor、durable mutation、outbox/saga、共同 commit、exactly-once、第二审计日志、historical compile 双视图和自创 CAP shape 也不能仅因“更稳健”而进入需求；它们没有来自当前问题清单的必要性。[E07][E20][E24]

## 十、事实来源索引

| 索引 | 核验位置 | 支撑事实 |
|---|---|---|
| **E01** | `AGG-544-gui-observability-gateway.md:44-48` | 操作员要求一眼判断运行、PC/移动、全链路、prompt 与类型化状态机预览 |
| **E02** | `AGG-544-gui-observability-gateway.md:124-130` | 协议真空、prompt 不可见、活性不可靠、宽 status、已有数据缺消费面 |
| **E03** | `AGG-544-gui-observability-gateway.md:153-165` | events 契约、轮转验证、关联键与既有数据源 |
| **E04** | `expected-foundation-544.md:27-31` | strict status、同 snapshot 与最终 wire 单源 |
| **E05** | `expected-foundation-544.md:37-41` | 三证、typed transport、identity/error 与生命周期保证 |
| **E06** | `AGG-544-gui-observability-gateway.md:19-27` | 独立 gateway、events 直读、mesh 信任、F 档与单进程 Web 宿主裁决 |
| **E07** | `AGG-544-gui-observability-gateway.md:50-77` | 十项终态、范围外与伞级验证边界 |
| **E08** | `demand-D07-544.md` | daemon 活性、死态、断网区分与生命周期用户闭环 |
| **E09** | `AGG-544-gui-observability-gateway.md:83-105` | 三数据面、daemon-down 服务与 gateway/daemon 边界 |
| **E10** | `expected-foundation-544.md:88-98` | status/events/transport/CAP-4 跨簇接缝及禁止平行事实源 |
| **E11** | `demand-D01-544.md` | strict read 的失败分类、证据中立与 snapshot 理由 |
| **E12** | `AGG-544-gui-observability-gateway.md:124-131,177-187` | 当前 SQLite reader 会写、迁移及其与 gateway 约束的矛盾 |
| **E13** | `demand-D06-544.md` | events history、active offset、rotation、SSE 与 daemon-down 可见性 |
| **E14** | `demand-D08-544.md` | exact F façade、daemon 裁决、结果 ADT 与 CAP-4 入口 |
| **E15** | `demand-D02-544.md` | attempt prompt/bindings 同源、resume、失败 diagnostic 与 pinned 来源 |
| **E16** | `demand-D10-544.md` | prompt 展示、legacy missing/write-failed 与不重建历史 |
| **E17** | `demand-D09-544.md` | 层级 URL、typed task tree、事件与对象双向导航 |
| **E18** | `demand-D11-544.md` | current compile artifact、三视图、schemaVersion 与禁止第二编译器 |
| **E19** | `AGG-544-gui-observability-gateway.md:107-118,490-502` | 信息架构、状态投影原则及 CAP-1/CAP-2/CAP-7 所有权 |
| **E20** | `expected-foundation-544.md:120-130` | 不升级为合同的 supervisor、replay、durable mutation、双视图等机制 |
| **E21** | `demand-D13-544.md` | 同应用 PWA、移动首屏、mesh 体验、控制可用与 PC 不回归 |
| **E22** | `expected-foundation-544.md:80-86` | CAP-4 identity、capability、decision consumer 与同源观测 |
| **E23** | `AGG-544-gui-observability-gateway.md:133-151,250-284` | TanStack/Bun spike、SSE abort 硬门、静态资产与精确 listener |
| **E24** | `demand-audit-544.md:G-H` | 范围增长审计与运行未知不构成新机制 |
| **E25** | `rolling-resplit-544.md:1-24,248-310` | 供给先行、消费者待真实接口后再拆及停止点 |
