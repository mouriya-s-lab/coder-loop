# RFC implementation draft 第三轮事实审计

> 审计对象：`.writing-rfc-implementation/draft.md`。本轮只复核第二轮三项修正及修文新增矛盾；对照 `AGGREGATE-547.md`、`24-r9-expected-foundation.md`、`28-r11-supply-demand-map.md`、`30-r12-rolling-decomposition.md` 与 `31-r12-decomposition-audit.md`。未修改 draft。

## A. 结论

**FAIL。阻断项：1。**

第二轮指出的 expected tool 例外与 runtime-produced value boundary 已正确修复；creation-event 收窄也已删除。但对该段的修文把 D10 create 的 outbox row 改成了强制的“outbox/effect intent row”，新生了 authority 合并与 create 合同扩张。

## B. 第二轮三项复核

| 第二轮项 | 结果 | 依据 |
|---|---|---|
| expected tool 缺席例外 | PASS | `draft.md:154,160,196-197,202,224,232,263` 已一致区分 gate/required tool 的 reject-or-hold 与 expected tool 的 continue + explicit `NotEvaluated`。 |
| creation event 非法收窄 | PASS | `draft.md:120-122` 已删除“派生事件/创建事件”，改为通用 commit-before-dispatch 与漏投递/未知外部状态。 |
| pre-run 与 runtime-produced value boundary | PASS | `draft.md:255` 已明确 pre-run candidate 在 create/update/batch admission，exit/outcome 在各自 typed runtime boundary。 |

## C. 新生阻断

### R3-F1 — D10 create 把 Outbox 与 Effect intent 合并，并新增强制 effect-intent row

**位置：** `draft.md:120,122`。

修文使用 `transactional outbox/effect intent row` 和 `outbox/effect intent`，会产生两项错误解释：

1. Outbox 与 Effect 是分立 authority，不能用斜杠合并成一个 row/type；draft 自己在 `:172` 也正确声明二者分域。
2. R9 Gate 2、D10 与 R11 D10-R10 对 instance create 的原子写集合裁定为 business row/ref/bindings/full runtime/**outbox rows**，没有裁定每次 create 必须额外生成 effect intent。Effect intent 属于实际需要外部 effect 的业务 transition/dispatch 合同；`draft.md:174` 对 transition 的表述是正确位置。把它强制加入 create 扩张了 D10 产品合同。

**具体修正：** `draft.md:120-122` 在 create 章节只写 `transactional outbox row(s)` 与“commit 后 dispatch 已提交 outbox”；若要概括所有外部 effect，只陈述它们不得在 create transaction 内执行。保留 `draft.md:172-174` 对 Effect ledger/intent 与 Outbox 的分域，不把两者写成同一种 row，也不要求无外部 effect 的 create 产生 effect intent。

## D. 其余回归检查

| 检查 | 结果 |
|---|---|
| current/target/dependency/proof 时态 | PASS；未出现新的已实现或已验证宣称。 |
| owner 与 transaction ordering | 除 R3-F1 外 PASS；create handshake、claim、gate evaluation、transition、after-commit dispatch 顺序仍正确。 |
| identity 与数据 | PASS；identity 分域及 15 chains / 69 items / 932 finished runs 未改变。 |
| R12 | PASS；source-ready 0、issue draft 0、not-yet 10。 |
| issue/SYNTH authority | PASS；issue 号未成为合同 identity，旧 SYNTH/child issue 未成为 authority。 |

## 尾结论

**第三轮事实审计 FAIL，阻断 1 项。** 三项原缺陷的行为语义已经修正，但 create 章节把 Outbox 与 Effect intent 写成 `outbox/effect intent row`，既合并了分立 authority，也把未裁定的 mandatory effect-intent row 加入 D10 create。将该段恢复为 D10 已裁定的 transactional outbox rows，并把 effect intent 保留在实际 transition/effect 合同中后再复审。
