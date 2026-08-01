# R9 地基最终复审

> 只读复核修正后的`AGGREGATE-547.md`与`24-r9-expected-foundation.md`；本轮只核原3项缺陷及整体R9 foundation gate。未查源码，未修改其他文件。

## A. 最终结论（≤1页）

**通过。缺陷数：0。**

原3项缺陷均已修复：

1. dependency现以稳定能力名作为合同identity：`independent schema consumer`、`tool outcome/finalize runtime`、`gate evaluator/journal`、`scripted join consumer`、`typed ChainDefinition provider`；issue号统一降为“出处 #N”，不再决定运行行为或依赖语义。
2. D2已删除tool outcome/finalize跨域dependency，只保留真实typed flow未完成E2E；tool outcome能力只留在D4、Gate-4和统一未交付账。
3. D4可复用资产已收窄为public projection/boundary槽位、通用identity与事务基建；hook carrier明确只属于D5 gate，不再冒充tool registry供给。

整体覆盖保持：

- D1–D10：10/10；
- Gate-1–Gate-8：8/8；
- R8正式决策：44/44，未映射0；
- 新需求0、新issue拆分0、代码实现0。

AGGREGATE继续作为完整决策/事实回锚，24号则是R10唯一预期地基摘要。24号每个D域和Gate均可回查AGGREGATE，对实然证据可继续回查R5/源码；它没有复制第二份ballot或把issue图升级成能力合同。

未实现的independent schema consumer、tool outcome/finalize runtime、gate evaluator/journal、scripted join consumer、non-degenerate par及冻结SHA整链仍明确标为dependency、typed unsupported/hold或proof gap，没有冒充已实现或已通过E2E。

因此R9 foundation gate已通过，R10可只以24号为预期地基，同时按其规则回看R5/源码核实现状。

## B. 原3缺陷复核

### B1. 能力合同与issue出处

| 稳定能力名 | issue号角色 | 判定 |
|---|---|---|
| independent schema consumer | 出处 #747 | 通过 |
| tool outcome/finalize runtime | 出处 #597 | 通过 |
| gate evaluator/journal | 出处 #712 | 通过 |
| scripted join consumer | 出处 #714 | 通过 |
| typed ChainDefinition provider | 出处 #705 | 通过 |
| compatibility real E2E | 出处 #685 | 通过 |

typed error使用`dependency-unavailable(independent-schema-consumer)`等能力identity，不使用issue号。issue可作为来源追溯，但不会因重拆、关闭或替代改变合同。

### B2. D2 dependency

修正后的D2 dependency列仅为：

> 真实 typed flow 未 E2E

source schema、admission、missing/null/default、render和agent-owned `exit.*`不再被tool outcome runtime阻塞。tool outcome/finalize正确留在：

- D4 tool registry；
- Gate-4 journals/effects；
- 统一未交付账。

跨域依赖已清除。

### B3. D4资产边界

修正后的D4可复用资产：

> public projection/boundary槽位、通用identity与事务基建

AGGREGATE还明确写明：

> hook carrier只属于D5 gate资产

这与R5一致：

- empty tools projection只保留wire位置，不证明registry；
- hook declaration carrier不构成tool registry；
- registry/requirements/outcome/finalize仍是待修补生产链。

tool与gate资产不再混域。

## C. 覆盖与权威

### C1. D1–D10

| 域 | 预期地基主题 | 判定 |
|---|---|---|
| D1 | CompileEnvelope/schema/doctor current | 通过 |
| D2 | recursive ValueType/admission/render/exit owner | 通过 |
| D3 | referenced tree/runtime identity/transition | 通过 |
| D4 | ToolId/四轴/registry/outcome | 通过 |
| D5 | gate identity/binding/pre-spawn/held | 通过 |
| D6 | canonical scalar/JSON renderer | 通过 |
| D7 | opaque chain/repository optional/local worktree隔离 | 通过 |
| D8 | plan不恢复/dead fragment同envelope | 通过 |
| D9 | explicit preset pin/typed ChainDefinition provider | 通过 |
| D10 | immutable publish/create/resolver/GC/legacy hold | 通过 |

### C2. 八个Gate

| Gate | 判定 |
|---|---|
| 1 Compile→Definition identity | 通过 |
| 2 Publish→create单事务 | 通过 |
| 3 v14 migration/pre-ref hold | 通过 |
| 4 Journals/effects分层authority | 通过 |
| 5 Pre-spawn held readiness | 通过 |
| 6 Recursive/par双层unsupported | 通过 |
| 7 Schema consumer dependency | 通过 |
| 8 De-GitHub/ChainDefinition/binding边界 | 通过 |

### C3. 44项与旧内容

AGGREGATE保留唯一44/44映射；24号只压缩成D域与Gate，不复制ballot。未发现：

- 旧候选/选项/推荐；
- 待用户回答；
- nested recursive grammar；
- doctor默认扫描instances；
-双identity、双journal、半实例；
- implicit migration/fallback；
- optional gate在executor缺失时inert；
- repository回流worktree/selector；
- current/expected混写。

## D. Dependency与proof边界

| 能力 | 当前状态 | 诚实行为 |
|---|---|---|
| independent schema consumer | 未落地 | dependency unavailable；不声称cross-owner E2E |
| tool outcome/finalize runtime | 未实现 | required unsupported/hold；expected不伪造成功 |
| gate evaluator/journal | 未实现 | capability不advertise；create reject/pinned hold |
| scripted join consumer | 未证明完整链 | typed unsupported |
| non-degenerate par | production链不存在 | 首副作用前`par_runtime_unsupported`+hold |
| compatibility real E2E | 未运行冻结SHA全链 | unit/fixture/文档不得替代 |

dependency、unsupported与proof gap均未被写成已交付能力。

## E. R10资格

24号现可作为R10唯一预期地基，因为它：

1. 完整覆盖D1–D10与8Gate；
2. 以AGGREGATE的44/44映射为唯一决策入口；
3. 以R5/源码作为实然核验入口；
4. 分离稳定条款、现状、预期、修补与proof gap；
5. 使用能力名而非issue号作为依赖合同；
6. 不新增需求、重拆issue或提前实现；
7. 不把未运行路径冒充完成。

## 尾结论

**修正后的AGGREGATE与`24-r9-expected-foundation.md`已通过R9 foundation gate：原3项缺陷全部清零，D1–D10为10/10、Gate为8/8、正式决策44/44且未映射0。依赖以稳定能力命名、issue号仅作出处，D2不再跨域依赖tool runtime，D4也不再借hook carrier冒充tool registry。缺陷数0，24号可以作为R10唯一预期地基；未实现能力仍不得声称已交付或已通过E2E。**
