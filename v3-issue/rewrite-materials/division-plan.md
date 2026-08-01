# v3 RFC 新划分方案（主 session 起草，v1，待对抗修订）

状态：草案第 1 版。本文件是主 session 的规划产物，将经过与 codex 执笔者的多轮对抗审读后定稿。定稿前不据此改 A.md 正文。

## 划分依据

划分不沿袭旧 543-548 六篇，而是取设计模型自身的三条自然接缝：

1. **定义态 / 运行态**：编译期可判的声明文本（类型定义、map 签名、占位符、谓词槽、后继闭集）与运行时才存在的事实（脚本结果、agent 填值、谓词真假、任务树外延）。
2. **函数域 / 对象域**：闭包内严格串行的五时态（抽象刻画时序）与任务间真并发的代数（抽象消灭时序）。两域只经针眼（入口 context₀ / 出口 returned|exception）相接。
3. **引擎内 / 边界外**：主流转机制与不参与主流转的东西——外部注入者、旁路观测者。

三条接缝正交，切出六个面：

## 面 0：公共设计模型（总纲）

- **管**：纯函数化公理（两提升口、self-report/measurement 信任压缩、副作用丢弃语义）、双域对偶与针眼、五时态与 context 单调累积概览、两层校验的形态区分（parser vs 带异常 map 的子函数）、异常时态归属规则、编译期/运行时精确边界、公共词汇（含 preset 术语开放项）。
- **不管**：任何一面的完整机制细节。总纲是词汇权威不是机制仓库。
- **现状**：草稿已 commit（c35d44b），欠至少一轮修订；已知四点问题（时序图参与者建模、两层校验缺落点、结局表标题、信任压缩原则缺失）+ 0.9 节按旧六篇写的约束整节重写为按新划分。

## 面 1：定义态——preset 定义资产、代码生成与编译面

- **管**：
  - preset 三面一体定义资产：类型定义、prompt md、各时态 map 骨架文件；"map 不写完 = preset 没写完"；骨架由 CLI 生成、注释枚举该时态可用 context、staleness 即失配。
  - 双面闭合检查：来源面（每值唯一来源 item|map|agent、签名完整）、消费面（占位符/谓词/路由读取引用已声明可达值）、谓词槽与后继闭集穷尽；finding 的警告/严格两档。
  - 定义冻结与取回：CompileEnvelope 唯一编译判定、三 identity 分域、不可变 publish、pin、shared resolver、corrupt/retiring/GC、legacy-definition-unproven、H1/H2 restart（旧 547 保留链全部落此面）。
  - 两个保证的正面表述："编译面正常工作"= 双面闭合+穷尽检查是编译期可判的可达性证明；"运行时有对应内容"= map 资产随 definition pin 进 bundle、resolver 按 ref 取回、缺失/损坏走 corrupt/hold 语义。
- **不管**：运行时求值结果（那是面 2）；任务结构的运行时外延（那是面 3）。
- **非目标节点名**：脚本的扫描、发现、注入的实现是纯 TS 工程事务，不属于 RFC 抽象面（操作员原话）。
- **对应旧篇**：547 主体保留改写；删 §6.2 tool/gate 协议、ToolOutcome/GateEvaluation journal、相关具名 dependency；543 的具名 gate 绑定（preset 声明抽象需求）随 gate 概念删除。

## 面 2：函数域运行时——闭包执行语义

- **管**：
  - 五时态执行细节：前置脚本 map 求值（Just/Nothing）、prompt 组装（仅 Just 可拼）、agent 时态（填值循环、出口校验、CLI 驳回报错）、后置脚本、流转判定（纯谓词一次求值）。
  - context 累积的精确规则（同名值唯一来源在编译期排除——面 1 保证，此面消费）。
  - 检查面/路由面正交；特殊 context 值与引擎可接管判据；"下一个 preset"n 三分（n≥2 chooser 闭集 / n=1 引擎填 / n=0 升层）。
  - fail total 语义：fail 特殊步骤、NIL、operator 全局配置级联（步骤→任务→组→item）、硬默认停机；纯程序节点（与 agent 节点共用合同）。
  - 异常时态归属的完整表（在场者消费规则的逐时态展开）。
  - runner provider 抽象：claude/codex/opencode/hapi 是纯函数调用的 argv builder 实现细节；provider 差异（argv/model/resume/session 解析/沙箱面）无一触及语义面；provider 接口的抽取方向（v2 现状是三目分派+平行字段）。
  - v2 关系：renderPrompt/单一 spawn 路径/凭据写回是本面的既有雏形；四个漏气孔（引擎 epilogue 常量、地址代值、隐式 env、session 身份错位）的封堵。
- **不管**：任务间调度（面 3）；endpoint 长期缺席的调度处置（挂起属对象域，面 3）。
- **对应旧篇**：545 重写（typed 提升口替代 opaque-existence；append/read entry 若保留降为旁路证据）；547 的 D2/D6 值渲染收编；543 的"gate 在 run post-exit 判定"由流转校验取代。

## 面 3：对象域——任务代数与调度

- **管**：
  - 三域切分、五动词（spawn/commit/admit/release/await）、节点消费群组（seq=大小 1 退化）、前向单调、异常作为落定值、dependsOn 布尔门、动态追加（位置+时机入链、重新锚定）、群组结束=消费+可选等待窗口（期满入日志）、finalizer 是普通 task。
  - committed transition/锁/crash replay、事件前缀重建 frontier、双 scheduler 竞争唯一活 run。
  - 闭包资源合同（worktree/branch/session、await 现场保留、release≠GC）、GC 消费谓词、publication 四值证据、三方 residue 对账。
  - 升层接缝：n=0 步骤耗尽→任务交接→chain 结束；await 不构成第二跨域通道的论证。
  - 迁移：v2 slot 串行是资源限制不是业务 seq，初始 items 解释为默认并行。
- **不管**：闭包内五时态（面 2）；定义冻结（面 1）。
- **对应旧篇**：546 主体保留 + record-1/record-2 增量（等待窗口、位置时机判定、五条承重代数性质的表述收紧）；删除与"预编译完整运行树"相关的叙事。

## 面 4：边界——外部注入与请求账本

- **管**：router/consumer/CLI 三层分权、into-chain/new-workspace 两语义、delivery/request/work 三 identity、幂等收敛、durable request record/query、CLI typed result ADT；schema 改为消费面 1 的类型权威（不自建平行模型）；外部注入走对象域 admit 的位置+时机判定（消费面 3 的合同）。
- **不管**：GitHub 业务映射细节（consumer 侧自有）；endpoint 传输层故障的调度处置表述归面 3 的 hold，本面只引用。
- **对应旧篇**：548 主体保留；external-terminal 一章收缩为"provider 传输层故障 + 对象域 hold"的引用性表述，probe/loss ordering 等契约保留为外部依赖事实。

## 面 5：观测与旁路——hook 与 GUI

- **管**：
  - hook：时态锚点上的旁路脚本（operator 声明、不参与 context、不影响流转）、锚点枚举来自时态结构、subprocess primitive（spawn/超时/进程组回收/at-least-once 恢复——543 保留链）、触发审计的最小记录。
  - GUI：context 面（时态快照、谓词结果、流转/fail 路径、对象域值账本）+ 副作用面（worktree、三证、events、日志、Git 残迹）二分本体；分栏的有限运维动作面（daemon 生命周期/unblock/decision，观测与控制共享 identity 不共享权威）；544 的交付纪律保留（进程独立、严格只读、单 root、mesh-only、attempt artifact、SSE 生命周期）。
- **不管**：主流转的任何裁决权。
- **对应旧篇**：543 收缩（observer 语义并入 hook，gate 全删）+ 544 重心调整（观测二分为本体，控制面降为附属节）。
- **悬置**：hook 与 GUI 合一篇还是拆两篇。合的理由：都是旁路、都是 operator 面、hook 被砍剩的体量单独成篇太薄。拆的理由：一个是脚本执行机制、一个是网关产品，工程形态完全不同。当前倾向合一篇两章。

## 跨面纪律

- 每面消费上游面的合同，不重定义：面 2 消费面 1 的类型/骨架，面 3 消费面 2 的针眼交付，面 4 消费面 1 schema 与面 3 admit，面 5 只读一切。
- 依赖方向单向：0 ← 1 ← 2 ← 3 ← 4，5 只读。任何反向引用是划分错误的信号。
- 旧 543-548 的编号与新面的对应关系在 A.md 重写后以映射表保留一处，不在各篇正文反复解释"以前这里是什么"。

## 主 session 自留的悬置点（对抗轮重点）

1. 面 5 合拆（上述）。
2. runner provider 的缺席语义（hapi endpoint 长期不可用→durable hold）放面 3 还是面 4：hold 是调度状态（面 3），但 endpoint identity/probe 契约是边界事实（面 4）。当前倾向：机制在面 3、契约在面 4，各留一半——这个切法是否制造了不必要的跨面接缝，需对抗。
3. 545 的 append/read entry（chain 内跨 run 拉取通道）在新模型里是否还有独立存在价值（作为旁路证据通道），还是完全被 typed context 取代：当前倾向保留为面 2 的一个小节（跨 run 拉取），但它与"context=闭包内时态容器"撞名的问题必须在词汇上解决。
4. 总纲 0.9 重写后，各面的"重写约束"是否还需要存在于总纲，还是移入本划分文件。
