# 草稿逐行实现标记(SYNTH-547 ↔ main@699842e)

> 对 `v3-issue/synthesized/SYNTH-547-type-system-compile.md`(草稿,行号 `L…`)的逐区段、逐断言实现标记。
> 证据全集见同目录 `03-raw-verification-results.md`(四组逐项验证,含 codex 深度验证两组 + 本线程自验两组);此处每条附最小证据。
> 标记词表:✅ 已实现 | 🟡 部分实现 | ❌ 未实现 | ⚠️ 过时(草稿断言与现状矛盾,重拆时必须改写) | ➖ 散文/元信息不可验证。

## 一、RFC 骨架(L14–169)

| 草稿行 | 断言 | 标记 | 证据 |
|---|---|---|---|
| L16–30 | 摘要、操作员 verbatim | ➖ | 设计意图,非实现断言 |
| L34 | 缺口"产物不可导出" | ✅ 已补 | compile CLI 落地(#549/#674) |
| L34 | 缺口"变量目标端 String 坍缩" | ❌ 仍在 | loop.ts:6075-6080 |
| L34 | 缺口"渲染失败语义三套不一致(item 静默 `""`、chain throw 可 default、runtime throw)" | ⚠️ 描述过时且问题仍在 | 实测:**chain 缺失也静默 `""`**(loop.ts:6039+6076),非草稿说的 throw;runtime throw(6053);不一致仍在但形态与草稿记载不同 |
| L34 | 缺口"doc 渲染按变量名特判" | ✅ 已修 | src 零 `=== "ISSUE"`;renderRuntimeInputsDoc 纯声明驱动(loop.ts:5824-5837) |
| L34 | 缺口"plan fragments 游离" | ✅ 已修 | plan/ 目录不存在、注册 0 |
| 裁决 A(L40) | 装载即编译 + compile CLI + 按需计算 | ✅ | 组1 A1–A7 全过;字节确定 |
| 裁决 B(L41) | TOML 载体 | ✅(维持) | PresetTomlBoundary 即 TOML 边界 |
| 裁决 C(L42) | ValueType ADT、source schema 类型权威 | ❌ | `rg ValueType src` 零命中;type 固定 "string"(loop.ts:2945) |
| 裁决 D(L43) | required/default、杀静默 `""` | ❌ | binding 无 required(字段全集 source/default/label/prefix/suffix/style/blankBefore,loop.ts:4993-5036);创建期校验不存在(daemon.ts:2166-2198,2887-3057 无) |
| 裁决 E(L44) | businessKeys 不加 computed | ✅(维持) | resolvePresetBusinessKeyValues 仅 literal(loop.ts:6064-6072) |
| 裁决 F(L45) | doc 渲染声明驱动 + 扩 prefix | ✅ | prefix 已在(loop.ts:672,4997,5015;#611) |
| 裁决 G(L46) | tools 四维正交 | ❌ | provider/availability/outcome/enforcement 工具语境零命中;无 [[tools]] |
| 裁决 H(L47) | 零原语六残留退役 | 🟡 | 六项中仅 doc 特判(第 5 项按草稿清单属 F)完成;详见零原语节 |
| 裁决 I(L48) | plan 退役 + dead-fragment 检查 | 🟡 | 退役 ✅;检查 ❌(dag-check 无 fragment 规则) |
| L52–66 编译管线设计 | 管线、六块、CompileResult、rejected diagnostics | ✅ | 组1 A1–A4;invalid → exit 1 + `{kind:"rejected",diagnostics:[{verdict,rule,message}]}` |
| L68 | identity 链跨 compile/SQLite/status/events | 🟡 | compile identity ✅(tasks:root/phase:*);SQLite/status/events 侧 TaskNodeIdentity ✅(task-runtime.ts:7-11、observability.ts:230-237)——**但两侧无生产接线**(树只有线性自动物化,identity 词表未对齐:compile 用 `tasks:root/phase:*`,运行态用 runtimeNodeId) |
| DSL 演进 1(L72) | seq/par 递归声明 + script 终态 | ❌ 声明面 / 🟡 运行态 | TOML 无树声明位(loop.ts:508-518);运行态 ADT/表已在(task-runtime.ts:44-58、sqlite-state.ts:661-725),join 仅 drain\|validator |
| DSL 演进 2(L73) | validator 的 item 调用声明 | ❌ | 无声明位;运行态 candidate `(definitionRef,candidateId)` shape 已在(task-runtime.ts:32) |
| DSL 演进 3(L74) | reopen target 静态引用 | ❌ 声明/校验 | 运行态 ParReopenSnapshot{count,budgetRef} 已在(task-runtime.ts:41) |
| DSL 演进 4(L75) | per-par 并发/reopen 预算声明位 | ❌ 声明位 | 运行态 reopen_budget_ref 列已在(task_par_nodes) |
| DSL 演进 5(L76) | 装载期结构检查清单 | ❌ | dag-check 无树规则 |
| DSL 演进 6(L77) | 产物含任务树结构 | 🟡 | 有 taskTree 块但恒退化 seq(compile 合成,loop.ts:2915,2935-2952) |
| DSL 演进 7(L78) | 具名 gate 点声明位 | ❌ | preset 无声明位;placeholder 类型已在无 loader(hook-declarations.ts:48、daemon.ts:1215-1232) |
| DSL 演进 8(L79) | 具名 join 候选声明位 | ❌ 声明面 | 运行态 join binding 版本表已在(task_join_bindings (par_node_id,version)) |
| L81–87 类型化转移路径 | transition path、exit.* schema、per-phase 出边查询 | ❌ | TransitionPath/pathId 零命中;PresetVariableSource 仅 item\|chain\|runtime(loop.ts:660-668) |
| 零原语 1(L93) | DEFAULT_PRESET_NAME 退役 | ❌ | 仍 seed(daemon.ts:2176);**但 #412 后已是 legacy default-seed 不驱动 item preset,且 chains.preset 列已可空、显式 null 通路已在**(daemon.ts:2168-2183、scheduler.ts:3239)——草稿"消解条件"部分已成熟 |
| 零原语 2(L94) | REPOSITORYREF+NOT NULL 退役 | ❌ | 列仍 NOT NULL(sqlite-state.ts:612);强校验仍在(daemon.ts:4745-4760);实测缺 repository 建 chain 被拒 |
| 零原语 3(L95) | `--issue`→`--item` | ❌ | `--issue` 仍主 flag(loop.ts:280 注释自认);`--item` 名已被 logs 的整数过滤参数占用(loop.ts:1379)——**改名将撞名** |
| 零原语 4(L96) | normalizeQueueIssueId 退役 | ❌ | 仍在(loop.ts:4371),queue unblock 路径调用(4021);item add 已 opaque——同 CLI 两套并存 |
| 零原语 5(L97) | inferRepositoryFromGit 退役 | ❌ | 仍在(loop.ts:4348,调用 4181) |
| 零原语 6(L98) | doctor 声明驱动 | ❌ | gh 无条件检查(install-commands.ts:140-169) |
| L100–104 plan 面退役调查 | 12 死 fragment、/dev-plan 烂 | ✅ 已退役 | 目录/注册/repo 内 dev-plan.md 均已不存在(退役来自 ff08ca2,非 issue PR);dead-fragment 检查 ❌ |
| L106–113 接口假设 | 跨树接缝 | 🟡 | **#712 能力(GateDecisionPoint)已在本仓库**(hook-declarations.ts:15-27,词表含 container.advance/chain.complete,与草稿 container.join 表述不一致);#677 context entry、#749 closure 已在;其余接缝未落 |
| L139–155 RFC 关闭验证 | 见下专节 | — | — |
| L157–162 验证边界 | 纪律声明 | ➖ | — |

## 二、RFC 关闭验证表逐行(L143–155,= #744 复核表 L703–715)

| 行 | 标记 | 证据 |
|---|---|---|
| 1 产物六块 | ✅ | 组1 A1/A2 |
| 2 零原语清零 grep | 🟡 | `=== "ISSUE"` 份额清零(测试残留 tests/unit/preset/load-bundled.test.ts:218);其余四符号全在 |
| 3 required 创建期 | ❌ | F3:daemon 无校验 |
| 4 json 渲染 | ❌ | F7:object 渲染 throw `cannot stringify`(loop.ts:6080),json 仅是 item-field 词表 |
| 5 工具约束定义期 | ❌ | G1–G3 |
| 6 dead fragment 暴露 | ❌ | C2 |
| 7 plan 退役 | ✅ | C1 |
| 9 验证阶段不漂移 | ❌ | 三类中仅 compile 类在;create/run-finalize 类无 |
| 10 定义不漂移 | ❌ | J4/J5:resume 读当前 preset;无缺失 hold |
| 11 identity 连续 | 🟡 | 运行态侧 identity/观测投影已在(J6);compile↔运行态无生产接线,seq(leaf,par(leaf,leaf)) 无法从定义构造 |
| 12 公共投影契约 | ✅ | 组1 A3/A4 + boundary round-trip(tests/unit/preset/compile.test.ts) |

## 三、OPEN children 逐条(L173–751)

### #735 doc 渲染(L175–216)——**整体 ⚠️ 过时:三条性质两条已落地**

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 完全声明驱动(L199) | ✅ 已落地 | B4 |
| P2 扩 prefix + bundled 迁移(L200) | ⚠️ 已落地(#611,早于本 issue 创建) | B2;bundled `prefix = "#"` 在 |
| P3 编译器守护 typed doc 结构(L201) | 🟡 | doc 字段 parse 在(4993-5036);外层 `variables?: "object"` 仍宽(loop.ts:496) |
| 验收:ISSUE grep(L207) | 🟡 | src 清零;测试残留 :218 |
| 验收:key 改名字节不变测试(L208) | ❌ | 无此测试 |
| 验收:prefix 生效(L209) | ✅ | tests/unit/preset/ 既有覆盖 |
| 验收:bundled diff(L210) | ⚠️ | 迁移已发生,diff 基线不存在 |
| **真实剩量** | — | boundary 精化(variables object→named union)+ 测试 selector 移除 + key-invariance 测试——与旧树终版契约(L1365-1432)记载一致 |

### #736 GitHub 记法退役(L219–264)——方向有效,基线 ⚠️ 过时

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 opaque id + wire `issue`→`itemId`(L243) | 🟡 | item add 已 opaque、wire `issueNumber` 已退(#419/#456);unblock wire 仍 `issue`(daemon.ts:532)、normalizeQueueIssueId 仍在 unblock 路径 |
| P2 repository 降 binding + 无物理列(L244) | ❌ | 列仍 NOT NULL;**metadata.bindings 通路已在**(#457)——迁移的目的地已存在 |
| P3 `--issue`→`--item` 改名(L245) | ❌ + ⚠️ | 未做;**`--item` 已被 logs 整数过滤参数占用**(loop.ts:1379),干净改名有撞名前提草稿不知道;点名的 `plan/init-queue.md` 已不存在(随 plan 退役) |
| P4 grep 清零(L246) | ❌ | 三符号全在 |
| 验收 migration"v13 库→新 daemon"(L258) | ⚠️ | 现行 schema v16;v13 基线失效 |

### #737 变量绑定类型流(L267–337)——核心未做,个别断言 ⚠️

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 source 类型权威(L291) | ❌ | F4/F6 |
| P2 静默 `""` 物理移除(L292) | ❌ | F1(且 chain 也 `""`——草稿问题描述(L283)引用的三套语义已过时) |
| P3 验证阶段准确(L293) | ❌ | F3 |
| P4 ValueType 公开消费(L294) | ❌ | F4 |
| P5 产物真实化(L295) | 🟡 | 有 type 字段但恒 "string"、无 required/default(F6) |
| P6/P7 exit.*(L297–298) | ❌ | F5 |
| 全部验收行(L309–320) | ❌ | 无一可过(typecheck 门除外) |

### #738 tools 注册表(L341–396)——全线未做

| 断言 | 标记 | 证据 |
|---|---|---|
| P1–P5(L363–367) | ❌ | G1–G5;仅 compile 占位 shape(loop.ts:573,580→2946,2954 恒空) |
| doctor 现状补充 | — | runner 检查从 status snapshot 推导(install-commands.ts:272-289)——草稿"与按 phase runner 推导同构"的锚点仍成立 |

### #739 phase task tree(L399–471)——**标记必须劈成两半**

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 递归声明 + identity 稳定(L423) | ❌ 声明面;🟡 运行态 identity 已在 | H1/H2 |
| P2 join 封闭 ADT drain\|validator(L424) | 🟡 | 运行态 union 恰为 drain\|validator(无占位 variant,符合准入纪律);无编译面 |
| P3 非法结构活不过装载期(L425) | ❌ | 无结构校验规则 |
| P4 参数归元数据(L426) | 🟡 | 运行态列(reopen_budget_ref、pin_commit)已在;声明位无 |
| P5 产物树非退化(L427) | ❌ | 恒退化 |
| P6 par guard(L428) | ❌ | H5:无 guard;调度仍线性 index |
| P7 join 候选声明位(L429) | ❌ 声明面;🟡 运行态 | task_join_bindings 版本表在(无追加 API) |
| P8/P9 transition path(L431–432) | ❌ | H6 |
| 验收"存量 preset 零改动兼容/线性→退化 seq"(L450) | ✅ 已成立 | compile 已做线性→退化 seq 合成 |
| 验收 identity 跨层连续(L451) | 🟡 | 运行态三面(SQLite/status/events)已可关联(J6);从定义构造嵌套树不可能 |

### #740 gate 声明位(L475–528)

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 声明位类型化(L497) | ❌(声明位);类型半在 | PresetHookPlaceholder 已在(I1),无 TOML 位、无 loader(I2) |
| P2 产物暴露(L498) | ❌ | I3 |
| P3 能力握手(L499) | ❌ | I4;gate script 本身不执行(I5)——"capability 未启用"是全局现状 |
| 锚定裁决 GateDecisionPoint(L501–503) | ⚠️ 部分过时 | ADT 已在本仓库且为八点词表(**container.advance / chain.complete**,含 daemon.startup/shutdown/tick);草稿锚定的 `container.join` 命名与"chain-complete 引用顶层 join identity"在代码中不存在——锚点需按已合入词表改写或裁决改词表 |

### #741 dead-fragment + plan 退役(L531–585)——**半个已被顺手做掉**

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 dead-fragment 检查(L553) | ❌ | C2 |
| P2 plan 面退役(L554) | ✅ 已完成 | C1(来自 ff08ca2,非 issue PR) |
| P3 不加跳转边(L555) | ✅(维持) | 无相关机制 |
| 决策项 dev-plan.md(L559) | ⚠️ 已决 | repo 内文件已不存在 |
| 验收"退役自洽:bundled findings 无 dead-fragment warn"(L567) | ⚠️ 语境剧变 | 当前 bundled findings **已有** 1 条 dead-vocabulary + 约 100 条 declared-unused warn(组1 C3)——"findings 干净"的隐含前提不成立,检查落地时的 fixture/断言须基于脏现状设计 |

### #742 chain preset fallback(L588–638)

| 断言 | 标记 | 证据 |
|---|---|---|
| P1 零 preset 名兜底 + 显式 null(L610) | 🟡 | seed 仍在(daemon.ts:2176);**null 通路/可空列/[#412 语义弱化]已全部就位**(E1/E2)——剩余工作显著小于草稿描述 |
| P2 单一 chain metadata boundary、消费 #705(L611) | ⚠️ | #705 boundary 不存在(chain 层无树声明位,E3);该依赖倒挂(聚合 §6-1)在现状下仍无解 |
| P3 item 恢复不受影响(L612) | ✅(维持) | statuses.entry 机制未变 |
| 验收 V-9b 依赖 #705 fixture(L620) | ❌ 不可执行 | 被消费物不存在 |

### #743 immutable execution definition ref(L641–683)

| 断言 | 标记 | 证据 |
|---|---|---|
| 问题陈述"#549 按需不落缓存、#558 关联 node id"(L659) | ✅ 前提成立 | #558 已合入(integration 驱动在) |
| P1 可保护字段闭集(L663) | ❌ | 无设计记录 |
| P2 tagged ref + 禁裸 hash(L664) | 🟡 | **Ref ADT + 严格 boundary 完整已在**(J1);表为 identity registry 不存内容、semantic_hash 占位(J2);preset contentIdentity 是真实源 SHA-256(J3) |
| P3 全消费者同源 + resume 在内(L665) | ❌ | J4:resume 读当前 preset;daemon 重启重读源——**正是本 issue 要修的漂移窗口,已证实存在** |
| P4 缺失定义 hold(L666) | ❌ | J5 |
| P5 无 MVCC(L667) | ✅(维持) | 无相关机制 |
| P6 join 演化不冒充定义切换(L668) | 🟡 | 运行态 join binding 版本机制已在(H3),append-only 无强制 |
| 验收 status/events/hook 同源(L677) | 🟡 | status/events 已暴露 definitionRef(J6);hook 无执行路径 |

### #744 综合验收(L687–720) | ❌ 不可执行 | 复核表 11 行中 4 行 ❌、3 行 🟡(见第二节);依赖的 #732/#733/#698/#706/#710/#726 仍不可识别 |

### #745 schema artifact(L723–751) | ✅ 问题陈述成立 | A8:无 schema 输出、无 package exports——缺口与草稿描述一致 |

## 四、#549 节与评论区(L757–1611)

| 区段 | 标记 | 证据 |
|---|---|---|
| #549 全部预期结果与验收(L757–856) | ✅ 已交付 | 组1 A1–A7;PR #674 merged @55ff3b2 |
| 契约 v5 教训:root identity 全量投影(L1269) | ✅ 已修 | preset.taskTree.identity == "tasks:root"(A6) |
| 契约 v5:real-e2e 撤销、engine-integration 替代(L1231) | ✅ 生效 | scripts/engine-integration.ts 是现行 gate(CLAUDE.md) |
| #550 终版契约剩量(L1381):boundary 精化 + 测试 selector | ✅ 仍准确 | B1/B3 逐项吻合——**这是全草稿对现状最准的一段** |
| #551 契约(L1450–1523):v13→v14、real-e2e C11 | ⚠️ 全面过时 | schema v16;real-e2e 验证边界已改 |
| 架构切片评论(L1526–1611) | ➖ | 定位描述,随各域标记 |

## 五、总览(按域一行)

| 域 | 标记 | 一句话 |
|---|---|---|
| D1 编译管线 | ✅(+2 遗留) | 全部落地;schema artifact 与 doctor/findings 关系未做 |
| D2 类型流 | ❌ | 三套失败语义仍在且 chain 也静默 `""`;ValueType/required/exit.* 全无 |
| D3 任务树 | 🟡 劈两半 | 运行态 ADT/表/identity/观测 ✅;声明面/编译校验/调度消费/transition path ❌;生产接线仅线性自动物化 |
| D4 tools | ❌ | 仅 compile 空占位 |
| D5 gate | 🟡 | 词表+四层声明模型+placeholder 类型已在;TOML 位/投影/握手/执行 ❌;词表命名与草稿裁决冲突 |
| D6 doc 渲染 | 🟡→尾声 | 剩 boundary 精化 + 测试 selector + invariance 测试 |
| D7 记法退役 | 🟡 | wire 半边已退;CLI flag/四符号/物理列未动;`--item` 撞名新前提 |
| D8 plan/dead-fragment | 🟡 对半 | 退役 ✅;检查 ❌ 且 bundled findings 已脏 |
| D9 chain fallback | 🟡 | null 通路/可空列/语义弱化就位;seed 未删;chain 声明 boundary(#705)不存在 |
| D10 定义 pin | 🟡 | Ref ADT/真实源 hash/三面投影 ✅;内容存储/resume 按 pin/缺失 hold ❌ |
| D11 综合验收 | ❌ | 4 行 ❌ 3 行 🟡;不可识别依赖未解 |
