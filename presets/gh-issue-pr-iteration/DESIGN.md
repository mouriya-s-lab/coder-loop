# gh-issue-pr-iteration 设计书

本文件是这个 preset 的设计思路记录，写给改 prompt 的人。它不注册进 preset.toml、不被引擎加载、不被任何文档引用——只解释这套 prompt 为什么长成这样。结构性的"什么文件在哪"看 `docs/gh-issue-pr-iteration-fragments.md`，本文只讲为什么。

## 前提一：runner 诚实但会犯错

runner 全是 Claude 家（Opus 4.7 为默认）。它们不会故意钻空子——诚实是 baseline，指令没写清就问、判据看得见就照着做。但诚实不等于不出错：会误读 issue、会跳步骤、会把 "似乎没变化" 当成 "已完成"。设计要点由此推出：

- 不堆双受众隔离与措辞警察式条款：步骤合同是单文件（Task / Report / Acceptance 三段同页），判据对执行者可见是有意设计；quality 判据也是单文件（执行侧约束与判断侧规则同源同文）；不做 issue body 篡改检测、不做每字段必填 SHA/URL/timestamp 的重模板、不写 "immutable / verbatim 亲读逐块比对" 的 Intent/Result 警察语——这些是给"爱作弊"runner 的对抗结构，Claude 家的 token 税与维护税盖不住其收益。
- 保留独立复核（review 的强制派发、e2e 直跑证据、runtime manifest）——诚实 agent 也会漏看，review 不亲自验证就是盲判。
- 过程纪律以 superpowers skills 为设计参考蒸馏进 step 文件：TDD 的 test-first 铁律、"根因先于修复、三次失败停手"、claim gate（先跑当轮命令读全量输出再落成功措辞）、"review 反馈是待核实的主张"——取纪律内核，按无人值守 loop 改编后内联（见前提八）。preset 自包含，不做运行时 skill 调用。

## 前提二：四 phase 的分工

引擎侧四个 phase 不变——`iteration` / `review` 是普通执行流，`blocked-responder` / `umbrella-finalizer` 是 trigger phase。preset 的复杂度全在前两个 phase 的 workflow 里。

- **iteration 调度者**：读 issue、按 deliverable signal 从四种路径中选一条（implementation-PR / unblock / source-writing-spike / comment-spike），派 subagent 逐步完成，产 PR 或 comment。iter 不写 item status；scheduler 由 run ledger 推进到 review。
- **review 调度者**：读 iter 交接的 handoff / trace / PR，派两个 subagent（diff-audit + replay）并行执行独立复核，然后亲自做诚实/协议判断，写 verdict、执行终局动作（accept / retry / expand / skip / blocked / stop）。
- **blocked-responder**：跨仓 unblock 副作用的最小化 responder。
- **umbrella-finalizer**：chain-complete 时的 umbrella 收官。

trigger 角色任务简单，单一 entry prompt，agent 一次跑完。iter/review 是调度者形态。

## 前提三：调度者的本职是维护任务清单

"调度"不是转发消息，是**把计划落成显式清单、保证每一行走到终态**：

- 列表先于执行写出，每行注明这次派发要产出什么、凭什么验收。
- 每行只有两种出口：`[x]`（由被验收的 subagent 汇报勾掉）或 `[-] skipped: <理由落进 handoff>`。
- 每次 verdict 后重印整张清单。
- 调度者亲自可执行的命令是闭集清单，清单之外的任何命令就是派发信号。

这条不动——是调度者架构的脊柱。

## 前提四：review 的信任来自独立复核，不来自阅读

Review 不读 iteration 说了什么来决定信任什么——派发独立 subagent 独立复核。两份报告（diff-audit + replay）各覆盖一个真值面，缺任一份 verdict（含 retry）无效：

- **diff-audit**（纯读）= scope / 卫生 / 代码真值 / 测试完整性。锚定 issue 声明的设计：每条发现必须带锚（可追溯失败路径 / issue 原句 / convention 来源），不发散。diff 中的测试删/改名/skip/弱化逐条枚举，含 test-collection 层（配置/glob/skip-marker/CI）变化，与 issue body 字面要求对照——测试变化在 diff 层已经完全可见，双侧装依赖跑全套只为了拿总数的仪式收益不抵成本，"计数以 runner 汇总行为准、禁止 rg/grep 静态计数" 作为一行口径分别写入 diff-audit（对 packet 侧）与 replay（对 head 侧）。同时对 issue-named 全仓收敛模式（`## 不应残留` / `## 预期结果` "升一等类型" / `## 验收标准` 数值红线）做一次性全 site 枚举——issue 自声明的全仓 pattern 是契约，不算发散。
- **replay**（占 AGENT_CWD + 驱动 iter 留下的 standing environment）= 契约行 / e2e / suite-count 真值。canonical 全套测试命令按 runner 自身汇总行取头端计数；验收表逐行真跑（`Env=browser` 行在 e2e re-drive 的真 UI walk 内执行）；按 iter 交接的 runtime manifest 复跑 packet e2e 主张（程序真实入口 / agent-browser 真 UI）；packet e2e 若为脚本产物即 form 失败；unblock-deliverable 路由必含 blocked-path e2e。同一个 subagent 覆盖 canonical 测试 + 契约行 + e2e 复驱 + 转交的 browser 行 + form check + standing environment 收尾——把跨环境的执行序列压在一个上下文里，减少 orchestrator 侧的多份报告拼图与 environment 争用。

另一个对称原则：**review 绝不替 iter 修**。code / evidence / PR body 都不动，只发 retry 反馈。

## 前提五：交付物必须以真实形态跑过，环境是交付物的一部分

unit/integration 测试必须有，但永远是辅助层。唯一的正规产物是 **e2e 直跑**：程序以操作者方式调真实入口，web 以 agent-browser 走真实 UI；"它是个库"不豁免（跑它的真实消费面）；**脚本 e2e 禁止**——包一层 harness 的就是集成测试。browser 验收行是 e2e 的一种，归 e2e 域执行，不双跑。

auth 和 binary 永远是执行者自己解决的：交付物要么是能自己起环境的单体程序（起环境时自铸 auth），要么是 IaC 基建里服务的插件（机器上必有可解析的 auth）。"no auth" / "no binary" 就是未完成的 setup，不是可报告的 blocker。

环境交接闭环：iter 跑完 e2e 把运行环境**留着**，交 runtime manifest（binaries、服务与启动命令、auth 解析位置——绝不写 secret 值、端口、在跑 PID 与停法）。review 凭 manifest 必然复跑得动——manifest 缺项是 packet 失败计入 retry，"review 跑不起来"被设计成不可能。全部 teardown 归 review 调度者收尾。

e2e 单独成步而不并入 verify：捆在重步骤里的麻烦环节会被整体跳过——单独一行清单 + 独立验收，跳过就关不掉清单。verify 与 e2e 并发跑（各自 worktree，避免 checkout 争用）。

## 前提六：每次运行无状态，GitHub 是唯一持久层

每次 spawn 的 agent 是独立进程，无跨轮记忆；本地文件会丢、会损坏、跨机不可用。持久业务语义只能落 GitHub（issue body / labels / comments / PR thread）。由此：

- issue↔PR 关联只认结构性链接（closing keyword 图，GraphQL `closedByPullRequestsReferences` 分页到穷尽），不做 body 文本搜索。
- retry 的指令源是 PR 的全量读取（body + 全部 comments + 全部 reviews + inline review threads）。最新 retry comment 与 PR body 的 caveat 段（scope-reduction trigger 可能出现的位置）要求原文引用；其余允许摘要——verbatim 收窄到判断依据可能被消歧的位置。
- 调度者的亲自阅读是核心少量项 + 一跳图引用；bulk 材料派 investigate。

## 前提七：Intent/Result 是工程日志，不是警察证据

iter 仍在 handoff 写 `Intent (run <RUN_ID>)`（动工前，声明 scope 与理解）与 `Result (run <RUN_ID>)`（完成后，声明 delta）。review 对照 Intent 与 Result 判断 scope 是否缩水——这是 intent-action mismatch trigger 的输入。

不配套"immutable / 禁止回填 / review 必须 verbatim 亲读逐块比对"这类警察语言。Claude 家没有系统性地伪造 Intent 的动机；写清楚就够，不用把每次读都变成侦查。

## 前提八：superpowers 是设计参考，不是运行时依赖

step 文件里的过程纪律段以 superpowers 插件（参考版本 v6.1.1）的 skill 原文为素材蒸馏而来，preset 自包含——不在运行时调用 `superpowers:*`。理由：运行时调用把 prompt 行为耦合到 runner 机器的插件安装与版本；skill 原文按交互式结对场景写（"ask your human partner" 分支、用户确认 gate），无人值守 loop 里这个人不存在；全文加载还会把大段不相关内容拉进 executor 上下文。

蒸馏落位与改编：

- `implement` 的 **Process discipline** 段 ← `test-driven-development`（test-first 铁律、"立即通过的测试什么都没测"）+ `systematic-debugging`（根因先于修复、单假设最小验证、三次失败即停）+ `receiving-code-review`（反馈逐条对照代码核实、技术性反驳、禁表演式同意）。原文的 "ask/discuss with your human partner" 一律改编为「记入 Problems 交 orchestrator 裁决」；TDD 例外（纯配置/文档）由 issue 契约决定，不问人。
- `verify` / `e2e` / `submit` 的 **Claim gate** 段 ← `verification-before-completion`（先跑当轮完整命令、读全量输出与 exit code、再落成功措辞；"启动成功"是 startup 证据不是行为证据；本地状态不等于 live）。判据侧的 claim↔observation 审计本就在 `quality/evidence.md` / `quality/honesty.md`，Claim gate 只补执行者动手时刻的程序性纪律。

未吸收：`brainstorming` / `writing-plans` / `executing-plans`（交互确认 gate）、`finishing-a-development-branch`（4 选项分支与 issue→PR 强流程冲突）、`using-git-worktrees`（preset 有自己的 worktree 纪律）。插件升级后要吸收新内容，重读原文再改 step 文件——不是改成运行时调用。

## 前提九：一致性铁律（防 livelock）

每处对 iter 执行侧的放松，必须同步放松 review 判据侧。步骤单文件（`iter/steps/<name>.md`、`review/steps/<name>.md`）是唯一事实源；执行者与调度者都读同一份，Task / Report / Acceptance 三段。跨文件交叉引用（如 evidence 要求、honesty 触发器、报告结构）在 iter-entry / review-entry / quality/*.md / review/actions/*.md 之间保持一致——改一处必须巡回核对四处。

## 写 prompt 的人最容易犯的错（本 preset 的事故记录）

- 站在作者视角写 why-and-how，读者视角下等于没写。每一句要回答的是读者此刻的问题：现在做什么、拿什么做、做完判断什么。
- 防作弊措施写过头变成自相矛盾（"PR body untouchable" 与全局路由模型冲突造成 livelock）。防的是重写叙事，不是结构修复——划界要划在动机上。
- 占位符不绑定（`<scratch>` 落哪没说）、API 失败语义不定义（sub_issues 404 算什么）、固定 cap 静默截断（first:10）——每一处含糊都是一个未来的卡死点或假阴性。
- 工具名写进机制描述（send_input / Task tool）会把 prompt 锁死在特定 runner 上；写机制（"同一 subagent 的 follow-up"），runner 自己映射。
