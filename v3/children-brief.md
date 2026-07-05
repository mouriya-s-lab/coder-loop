# v3 RFC children 拆解简报（总控，2026-07-02）

> 读者：各 RFC 的 children 拆解子会话。你的任务：把你负责的那个 RFC issue 拆解成原子实现任务 issue（children），经 sub-issue API 挂到该 RFC 下。**必须先 invoke `writing-complex-issues` skill 并按其路由读完 child-body / decision-closure / adversarial-review / mechanics 各 references**，child body 用 future-work checkpoint 形态（Problem / Expected Outcome / Acceptance Criteria / Dependencies），落地前过对抗审查与发布自检。

## 全体须知

- RFC body 是已裁决契约：children 不重开 RFC 已裁决的决策，只把「实现拆解 children（后续规划挂接）」的承诺落成任务。RFC 的关闭验证表各行必须被 children 的 Acceptance 覆盖（伞的验收行 = children 验收的并集，不许缩水）。
- RFC body 里的「开放问题（实现 child 落地时裁）」逐条分配进对应 child body，作为该 child 的显式决策项；不许悬空。
- 代码锚点自己在仓里 grep 核实（基线 main，RFC 引用的行号可能漂移——按「命令坏 → 先修锚点再引用」处理）。
- 每个 child 恰好一个 closing PR；PR 不做 child。单 parent。
- 与 #534 audit 树（#535–#542，open）的排序默认值：audit children 先合，v3 children 在其后 rebase——#535/#536/#538 与 v3 调度手术触同一批 `src/scheduler.ts`/`src/daemon.ts` 面。偏离此默认需在 child body 里写明理由。
- 正文中文、固定 token 英文、引用原文可追溯（格式见 skill 硬基线）。

## 已钉的跨 RFC child 级依赖边（拆解时必须物化成 Depends on / Blocks）

这些边来自六 RFC body 已收口的接缝（2026-07-02 总控整合 pass），不是建议：

1. **#546 的首个 child 必须是「任务树运行态 + status 快照树结构 shape」**（#546 接口假设的 shape 承诺：设计期钉住持久化形态与快照 shape）。它 Blocks：#544 的「快照 boundary 收紧」child、#545 的「group scope 键存储」相关 child。
2. **#547 的「编译管线 + `preset compile --json` 编译产物」child** Blocks：#544 的「元信息预览」child、#548 的「外挂请求预校验」child、#543 的「全量元数据投影」child。
3. **#547 的「DSL 演进面第 7 项：具名 gate 点声明位」** Blocks #543 的「preset 级抽象 gate 点」child。
4. **#547 的「[[tools]] 注册表 + toolRequirements 编译」child** Blocks #545 的「required|expected 执法」child。
5. **统一判定契约 `advance | hold | reopen(target, corrections)`**（#546 核心模型 + #543 执行模型，已统一）：执行器机制（script spawn、stdout decision、fingerprint 幂等泛化）归 #543 children；join 评估与 seq 游标/reopen 调度归 #546 children。两边 children 各自引用同一契约文本，不复制不改写。
6. **#544 的「prompt 落盘（prompt.md + bindings.json）」child 无上游依赖，可先行**；其 `bindings.json` 的类型化值形态引用 #547 typed bindings child。
7. **#548 已有两个 children**（#418 spike、mouriya-s-lab/hapi-remote-session#1）；其余待立：消费 daemon repo 立项、router 演进需求登记（后者落 router repo，#548 只登记指针）。

## 波次

- **W1（先行）**：#546、#547 各自拆解——两树的地基 child（边 1、边 2）编号产生后，下游才能引用。
- **W2**：#543、#544、#545、#548 拆解，跨树边用 W1 已产生的真实 issue 号。

## 上下文文件（绝对路径，不在 worktree 里）

`/Users/mouriya/Ext/code/coder-loop/.v3-design/` 下：`v3-goals.md`（目标 verbatim）、`rfc-split.md`（拆分依据）、`survey-engine-daemon.md`、`survey-preset-types.md`（现状调查）。RFC issue 本体用 `gh` 全量拉取到本地再读（body + comments）。
