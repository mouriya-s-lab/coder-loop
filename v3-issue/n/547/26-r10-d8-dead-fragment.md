# RFC 547 R10/D8 — Plan 退役与 dead-fragment 需求侧推导

> 只读输入：`AGGREGATE-547.md` D8、`24-r9-expected-foundation.md` D8 与 Gate-1/2/7，以及 compile/finding 供给摘要 A-01/A-02/A-04、D-01/D-06、T-01/T-02。本文不读源码、不复用旧 issue 边界、不估规模、不新增需求。D1 的 CompileEnvelope/finding authority 已冻结；D8 只提供 analysis rule 与 finding，不复制 compiler、doctor 或 projection authority。

## A. 主 agent 摘要（≤1页）

D8 的目标只有两部分：**plan 面完全退役**，以及 **已有 fragment declaration 必须可由真实 consumer 到达**。两者不能通过恢复 plan、发明 jump/redirect DSL 或建立旁路 checker 来互相补偿。

现有地基已经证明 plan 目录、注册与命令退役，且没有 fragment jump DSL；canonical compiler、closed compiled/rejected result、non-empty diagnostics 与唯一 projection boundary 可复用。实然缺口是没有 dead-fragment analysis，bundled 输入“没有 warning”可能只是规则未运行；手传 findings、只断言 no-error 或 projection shape 不能证明同源。

reachability 只从 canonical compiled product 中已经存在的真实 consumer root/edge 计算。fragment 名字、文件存在、声明顺序、legacy plan 字段、注释/文档文本和潜在未来 consumer 都不是边。无 root 可达路径的声明产生 structured dead-fragment finding；duplicate/dangling consumer ref 是各自结构错误，不能被 dead finding 吞并。finding 写入同一 CompileEnvelope，由现有 compile callback/public projection/doctor current-definition 读面派生；D8 不建第二 finding store、扫描命令或 overall truth。

variant/ownership 清零覆盖 plan 在 source schema、compiled ADT、projection/schema、CLI/API、persistence/migration、runtime selection 与 allowlist 中的全部 authoritative role。历史不透明数据只按既定兼容/迁移边界处理，不把 plan 恢复成 runtime variant。删除 plan 后不得以 fragment jump、implicit order 或 string target 重新引入等价控制面。

原子需求共 **16** 项。验证分 compile rule、projection/doctor 同源、plan surface 清零与 bundled/external fixture；冻结 SHA 人口核对仍是证明缺口，不得以文档或当前无 warning 冒充完成。

## B. 原子需求

### B1. Plan 面完全退役

| ID | 原子需求 | Authority / write rule | 匹配与验证 |
|---|---|---|---|
| D8-R01 | plan 不得作为 source declaration、compiled product variant、runtime selector、scheduler input 或 execution identity 出现。 | canonical source/compiled/runtime ADT 穷尽列举；无 plan owner。 | boundary 对 plan variant/field typed reject；exhaustive switch 无 plan branch。 |
| D8-R02 | plan 的目录、registry、命令与 public API 入口保持退役；不得增加 alias、compat command 或 hidden fallback。 | CLI/API schema 只暴露现行 definition/fragment surfaces。 | help/schema/command negative tests；unknown plan command/field 明确失败。 |
| D8-R03 | persistence、migration 与 wire format 不得新写 plan；历史 opaque remainder 不成为 executable plan，也不自动转成 fragment edge。 | new-write boundary 拒绝 plan；migration 只保真或按既定 typed policy hold。 | new write、legacy read/round-trip、restart 均不产生 plan authority。 |
| D8-R04 | projection/schema/doctor/status 不得发布 plan variant、plan owner 或 plan-derived current selection；历史 allowlist 必须最终清零。 | D1 canonical projection 是唯一公开 shape。 | schema/projection snapshot、unknown-version boundary、historical allowlist audit。 |
| D8-R05 | 删除 plan 后不得新增 fragment jump/redirect/goto、implicit next、string target 或基于声明顺序的替代 DSL。 | consumer edge 只来自现有 canonical typed references。 | source negative tests覆盖显式 jump 与等价 alias；reorder 不改变 reachability identity。 |

### B2. Fragment declaration 与 reachability

| ID | 原子需求 | Read model | 匹配与验证 |
|---|---|---|---|
| D8-R06 | 每个 fragment declaration 必须具有 definition-scoped stable FragmentIdentity；路径、数组 index、声明顺序与 display name 不得冒充 identity。 | compiler 读取 canonical fragment table。 | duplicate identity、跨 definition ref、reorder/move round-trip。 |
| D8-R07 | reachability root 只能是 compiled product 中已经存在且会消费 fragment 的 typed root；“可能未来使用”、文件存在、注释或文档文字不是 root。 | D8 analysis 只读 canonical compiled product，不读 runtime/current cache猜测。 | 无 root、单 root、多 root 与无关文本 fixtures。 |
| D8-R08 | reachability edge 只能是现有 consumer declaration中的 typed FragmentRef；不得从字符串包含、命名约定、目录关系或 plan legacy 字段推断。 | compiler 已解析的 typed refs 是 edge authority。 | false-positive string/name/path cases；合法 direct/transitive refs。 |
| D8-R09 | analysis 从全部真实 roots 对 FragmentRef 图做确定性传递闭包；direct 与 transitive 可达均不报告 dead，共享 fragment 只计一次。 | pure analysis，无 IO/DB 写；输出按 stable identity/location 确定排序。 | chain/diamond/disconnected graph、source reorder、重复 root。 |
| D8-R10 | duplicate declaration、dangling ref、invalid ref kind 与 cycle 按各自 compile structure error 处理；不得压成 dead-fragment warning。若 cycle 合法性由其他 frozen grammar 决定，D8 只消费其已判结果。 | D1 CompileEnvelope 汇总 typed diagnostics；D8 不重定义 grammar。 | 每类结构错误的 code/path；dead finding 集不掩盖 fatal error。 |

### B3. Structured finding 与同源读面

| ID | 原子需求 | Finding contract | 匹配与验证 |
|---|---|---|---|
| D8-R11 | 每个不可达 fragment 产生 structured finding，至少含稳定 code、severity、FragmentIdentity、source location 与“无 consumer path”原因；不得只输出拼接字符串。 | finding 写入本次 CompileEnvelope；无独立 store。 | 单个/多个 dead fragments、稳定排序、JSON round-trip。 |
| D8-R12 | dead-fragment finding 与 model/warnings 不可拆开成功返回；compiled envelope 必须携带完整 finding，rejected envelope 仍保留适用 diagnostics。 | TF-01 CompileEnvelope 唯一 authority。 | direct compile、daemon callback 与 cache path 返回相同 finding 集。 |
| D8-R13 | public projection、compile callback 与 doctor current-definition section 只派生同一 envelope；不得手传、重扫或单独维护 dead finding。 | D1 projection/doctor 只读 CompileEnvelopeRef。 | 同一 source bytes 的 CLI/callback/doctor structured equality；不合并 pinned instance truth。 |
| D8-R14 | cache/materialize/publish 只有在 source identity 与完整 envelope 对齐后才可复用；旧无-rule cache 不能隐藏新 finding。 | Gate-1 verified envelope identity；D8 不自建 cache。 | source edit、rule/schema version change、restart/materialize rollback 后 finding 不丢失。 |

### B4. Consumer 与验收清零

| ID | 原子需求 | Consumer guarantee | 匹配与验证 |
|---|---|---|---|
| D8-R15 | downstream consumer 只接收 canonical fragment identity/ref 与 CompileEnvelope finding；不得要求 plan owner、jump target、scan result 或 separate checker response。 | schema/public boundary 描述现行 fragment/finding shape。 | consumer contract round-trip；unknown field/version reject；无 private compiler duplication。 |
| D8-R16 | bundled 与外部 fixture 必须同时包含 reachable、transitively reachable、dead、dangling/duplicate 及 plan/jump negative cases；断言具体 structured code/identity/location，不能只断言 no error/no warning。 | test 只验证 D1+D8 合同，不成为 finding authority。 | 冻结 SHA 人口核对记录真实 dead count；结果未运行前保持 proof gap。 |

## C. 地基匹配与责任边界

| 分类 | D8 使用方式 | 不得升级为 |
|---|---|---|
| 24 地基已供 | canonical compiler/result、non-empty diagnostics、唯一 projection boundary；plan 目录/registry/command 已退役且无 jump DSL | 当前 bundled 无 warning 不证明 dead rule 已存在；手传 finding 不证明同源 |
| 修补后复用 | D1 完整 CompileEnvelope、cache/materialize/doctor 同源；Gate-1 envelope identity；Gate-7 versioned schema/public consumer boundary | D8 不复制 compiler、cache、doctor、schema producer 或 independent consumer |
| D8 自建 | R01–R16 的 plan surface清零规则、canonical fragment reachability analysis、structured finding与相应验收 | 不扩张 fragment grammar，不新增 jump/control DSL，不改变 finding authority |
| 具名 dependency | independent schema consumer 仅用于证明公开 fragment/finding schema 可被外部派生；不是 reachability authority | dependency 缺失不得促成手写 consumer shape或旁路 checker |
| 地基未闭合 | dead-fragment rule、cache/rule-version invalidation、doctor同源、historical allowlist清零、bundled/external冻结 SHA 人口核对 | unit shape、无 warning、文件删除或文档声明不得冒充完成 |

## D. 验证分层

| 最早可决定点 | 必须验证 |
|---|---|
| source/boundary | plan field/variant/command/jump alias 拒绝；FragmentIdentity 与 typed ref parse |
| compile structure | duplicate、dangling、invalid-kind、cycle 与 dead finding 分类不混淆 |
| reachability | root/edge定义、direct/transitive/shared/disconnected图、reorder确定性 |
| envelope/projection | structured finding code/identity/location；CLI/callback/cache/doctor同源 |
| materialize/publish | source/rule/schema version变化不复用旧无finding artifact；失败无完成产物 |
| consumer | versioned schema round-trip、unknown version、无plan owner/jump/separate checker依赖 |
| population | bundled与外部冻结 SHA 真实 dead 数、historical plan/allowlist清零；未跑前保持缺口 |

## 尾结论

**D8 的 16 项原子需求在不恢复 plan、不新增 jump DSL、不复制 compiler 的前提下，把 canonical fragment consumer 图的不可达声明转成同一 CompileEnvelope 中的 structured dead-fragment finding，并由 projection/callback/doctor 同源读取。现有 plan 退役与 compiler 骨架只是可复用地基；reachability rule、variant/ownership清零、cache/doctor贯通及 bundled/external 冻结 SHA 验证仍未闭合，不得以“当前无 warning”冒充完成。**
