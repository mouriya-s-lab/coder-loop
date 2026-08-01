# R8 最终复审 — `22-r8-final-decisions.md`

> 只读复核局部修正后的22号正式决策；本轮只检查Gate-6残留与整体R8恢复gate。未查源码、未修改其他文件。

## A. 最终结论（≤1页）

**通过。缺陷数：0。**

Gate-6现已统一为：

> 在`referenced-node recursive boundary/normalizer`尚未交付时，任何`[tasks]`输入在compile返回typed rejected `recursive_tasks_unsupported`；linear `[[phases]]`正常。

该措辞与TF-25正式裁决、摘要、44项映射及R9回写要求完全一致：

- recursive TOML唯一主语法为referenced node table；
- stable node id与child id refs不依赖声明位置；
- linear phases只作compat语法糖并立即normalize；
- 两种recursive grammar不会并存；
- boundary未实现时compile显式拒绝，不再静默丢弃`[tasks]`；
- recursive compile已实现但par runtime未实现时，create/schedule在首个副作用前返回`par_runtime_unsupported`并hold；
- legacy/旁路par rows仍有scheduler backstop；
- 不允许顺序降级。

原审计指出的6项合同缺陷及最后1项术语残留均已局部修复。22号现状仍保持：

1. 44/44决策唯一映射，未映射0；
2. 5个A准确恢复稳定条款；
3. 7个I均转为有事实依据的migration、unsupported或hold约束；
4. 26个E各归唯一工程合同；
5. 6个自主裁决与21号正式决策一致；
6. 8个统一Gate没有双identity、双journal、半实例或隐式fallback；
7. v14 pre-ref人口不被current source伪造；
8. #747、#597、#712/#714和non-degenerate par仍明确标为未实现dependency及验证缺口。

因此R8只声明规范/合同收敛，不冒充代码、外部owner链或真实E2E已经交付。R9可以按22号B8回写规格、issue图、dependency和验收边界；不得恢复ballot、nested grammar、隐式兼容或把proof gap扩成产品需求。

## B. Gate-6核对

| 检查 | 结果 |
|---|---|
| TF-25语法 | referenced node table |
| Gate-6 boundary术语 | referenced-node recursive boundary |
| linear兼容 | `[[phases]]`正常并normalize |
| 未实现compile行为 | `recursive_tasks_unsupported` |
| compile后runtime缺失 | `par_runtime_unsupported` + hold |
| 拒绝时点 | create/schedule首个资源/run副作用前 |
| legacy旁路 | scheduler backstop |
| fallback | 禁止顺序降级与静默warn |
| R9指令 | referenced node table，不回退nested inline |

## C. 整体R8 gate

| Gate | 判定 |
|---|---|
| Gate-1 Compile→Definition identity | 通过 |
| Gate-2 publish/admission/create/runtime/outbox事务 | 通过 |
| Gate-3 v14 migration与pre-ref hold | 通过 |
| Gate-4 Transition/Tool/Gate/Effect/Outbox authority | 通过 |
| Gate-5 pre-spawn held readiness | 通过 |
| Gate-6 recursive/par双层unsupported | 通过 |
| Gate-7 schema consumer dependency | 通过 |
| Gate-8 De-GitHub/ChainDefinition/binding边界 | 通过 |

未发现遗漏、冲突、ballot残留、用户作业、范围扩张或把外部依赖冒充完成。

## 尾结论

**`22-r8-final-decisions.md`现已通过R8恢复gate：44/44映射完整，8/8统一Gate一致，原全部缺陷已清零。Gate-6与referenced-node正式语法完全对齐，同时保留compile与runtime双层具名拒绝。缺陷数0，可进入R9规格与issue图回写；未实现dependency仍不得声称已交付或已通过E2E。**
