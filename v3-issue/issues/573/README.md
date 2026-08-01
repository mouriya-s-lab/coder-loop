# #573 feat(engine): events 消费契约固化——boundary 导出与滚动段规则测试钉住

- state: **closed**  | author: `RiriAgent`  | created: 2026-07-02T12:02:01Z  | updated: 2026-07-13T05:44:38Z
- closed: 2026-07-13T05:44:23Z  | state_reason: `completed`
- labels: (none)
- url: https://github.com/mouriya-s-lab/coder-loop/issues/573
- comments: 5  | timeline events: 20

---

## Body

## 必须先读的关联 issue

#544（RFC: v3 可观测性 API 与 Web GUI）。继承条款逐字快照：

> "**events 契约面固化**：`ObservabilityEventBoundary` 与滚动段命名/顺序规则作为网关消费契约导出（同仓类型 import），滚动/翻段行为有测试钉住——网关按契约读段，不逆向猜文件名。" — #544 引擎侧新增工作 2

> "推送通道｜**网关直读 events JSONL**（`fs.watch` + offset 增量），否决 socket 订阅 verb｜daemon 死时通道依然活；零引擎改动。**豁免声明**：#411「消费者从此不刮 runtime 文件」禁令对网关一家豁免（同仓同版本演进的特许消费者），对 supervisor/agent/脚本等其他消费者禁令不变" — #544 裁决记录 B

## 目标

把网关直读 events JSONL 所需的一切事实——事件 schema、段文件发现与全序规则、翻段行为——从实现内部事实升格为导出契约并用测试钉住。

## 使用场景

基座 child：#577（网关 events 直读与推送）按本契约读段。无 CLI/UI 触感，只为消费者提供不漂移的读取面。

## 上下文

Repo `mouriya-s-lab/coder-loop`，基线 main@b92ddaa（2026-07-02 核实，实施前自行 grep 行号）。

- 事件类型 union：`ObservabilityEventTypeBoundary`（`src/observability.ts:24-132`），44 种事件类型；kind 词表 `ObservabilityKindBoundary`（`:16-22`）：`audit`/`decision`/`lifecycle`/`validation`/`diagnostic`。
- 信封：`ObservabilityEventBoundary`（`:243`，导出类型 `ObservabilityEvent` `:705`），base 字段 `ts`/`chain?`/`item?`/`runId?`/`phase?`/`subject?`（`:234-241`）——chain/item/runId/phase 即 #544 信息架构的关联键。
- 滚动机制：`OBSERVABILITY_EVENT_SEGMENT_BYTES = 32MB`（`:753`）；`shouldRotateObservabilityEventStream`（`:1120`，日界或超量触发）；段命名 `rotatedObservabilityEventSegment`（`:1125`，`${activeBasename}-${sanitizedTimestamp}-${randomUUID()}.jsonl`）；写入 `appendObservabilityEvent`（`:795`）/`appendObservabilityEventSync`（`:806`）。
- 现状反例：`logs --follow` 是 CLI 1s 轮询全量重查（`runLogsCommand`，`src/loop.ts:1824`，loop `:1836-1844`）——不是可复用的消费契约。

## 问题

段命名、滚动触发、段间顺序都是实现内部事实：命名模板含 `randomUUID()`，历史段之间的全序没有任何被声明或被测试的规则；boundary 类型虽存在但「消费者怎么发现段、按什么序读、翻段瞬间怎么不丢不重」无契约无测试。#544 裁决 B 把 events 文件钦定为网关正式契约面（见上引豁免声明）——契约面不能建立在可静默漂移的隐式行为上。

## 预期结果

性质表述：

1. **消费所需事实全部经导出面获得**：同仓消费者需要的一切——事件 union 与信封 schema、active 段识别、历史段发现与全序判定、翻段一致性语义——由导出的类型/常量/纯函数承载；消费者零字面量拷贝（import，不复制正则/命名模板）。
2. **段全序可判定**：任意一组段文件名，导出的规则函数给出确定全序（含同日多段）；该规则有测试钉住。
3. **翻段不丢不重**：跨翻段的顺序读取语义有测试——模拟消费者在 rotation 前后按契约读取，事件序列无丢失无重复。
4. **穷尽演进**：事件类型/信封字段演进时，编译器（arktype schema 派生类型 + 穷尽消费）暴露消费端全部处置点，不靠 grep。

## 不应残留

- 本 child 范围内：不留「契约导出」与「写入实现」两份平行的命名/滚动逻辑（导出规则必须就是写入方使用的那一份）。
- 范围之外不动：事件类型词表内容与发射点（#411 既有格局）、`logs --follow` CLI 行为、网关 reader 实现（归 #577）、daemon socket 协议。

## 约束

- 代码红线（#544 约束节逐字）："必须全链路 ADT，禁止任何类型退化。不引入 `any` / 匿名形状；`unknown` 仅限 catch 与边界 parse 入口；禁止真 `as` 断言（`as const` 除外）；外部输入经边界 parse（arktype）为精确类型后流转；不得删除类型依赖、绕过或降级既有类型边界。违反红线 = changes requested，无例外。"
- "#411 的「消费者不刮 runtime 文件」禁令对网关之外的一切消费者继续有效；events 直读豁免仅限同仓网关。"（#544 约束节逐字）——本 child 的导出面不得被文档表述为通用公共 API。
- 排序默认（总控简报 2026-07-02）：#534 audit 树 children 先合，本 child 在其后 rebase；偏离需在 PR 说明。

## 验收标准

| Dimension | Check | Command | Env | Expect |
|---|---|---|---|---|
| function | 段全序规则 | `bun test`（新增用例：构造乱序段文件名集合，含同日多段，断言规则函数输出确定全序） | 本机 | 断言通过 |
| function | 翻段不丢不重 | `bun test`（新增用例：写入跨 rotation 的事件序列，用导出 API 顺序读，断言与写入序列逐条相等） | 本机 | 断言通过；rotation 两条触发路径（日界、32MB）各有用例 |
| function | 单一事实源 | `bun test`（用例：写入方实际产生的段名必须被导出规则函数识别并排序） | 本机 | 断言通过——写入与消费共享同一规则实现 |
| environment | 既有测试不回归 | `bun run typecheck && bun test` | 本机 | 全绿 |

## 依赖关系

- Depends on: 无。
- Blocks: #577（网关 events 直读与实时推送）。


---

## Comments (5)

### comment #4866583408 by `RiriAgent` — 2026-07-02T14:02:18Z

## 架构切片

1. **系统定位**：B 域事件流的消费契约出口级——写入实现（rotation/段命名）升格为导出契约；事件语义与发射点不动。
2. **全局坐标**：引擎 events 写入域 → 同仓特许消费者域（网关）；边界物 = 导出类型/常量/纯函数 + 钉住测试；信任级为同仓同版本演进（B 裁决豁免条件）。
3. **类型↔值不漂移**：防类型泄露——消费者复制段名正则/信封 shape 即把引擎内部编码进消费端；防值漂移——写入规则变更而消费者不知，单一规则实现共享封死。
4. **消除的错误类别**：「网关逆向猜文件名、翻段丢/重事件」从可能变为不可表达。

## log/观测义务

无新增事件义务（契约固化，非行为变更）。


### comment #4953811022 by `RiriAgent` — 2026-07-13T02:11:19Z

<!-- coder-loop:executable-contract schema=1 source-issue=573 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/573
- Observed body update timestamp: `2026-07-02T14:02:18Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/573#issuecomment-4866583408
- Inherited architecture source: https://github.com/mouriya-s-lab/coder-loop/issues/544
- Downstream consumer source: https://github.com/mouriya-s-lab/coder-loop/issues/577
- Current-source observation: `main@f01560d5d0b324e791db7f599e502f09fc78a652`; `src/observability.ts` still keeps the three ArkType boundaries private, generates history names with `randomUUID()`, and discovers/sorts segments through private filename logic. Historical PR #654 is closed and unmerged, so iteration starts from current `main` rather than migrating that head.

## Deliverable

`implementation-pr`

One PR closes #573. It exports the same-repository events-consumption contract from `src/observability.ts` and pins it with tests; it does not implement #577's gateway reader, change event vocabulary/emission sites, change `logs --follow`, or change the daemon socket protocol.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| `C1` | contract-focused behavior | `shell` | `bun test src/observability.test.ts` from repository root; local Bun environment | Exit 0. Tests cover exported event/schema parsing, deterministic discovery and total ordering of shuffled active/history filenames including multiple same-day segments and an ordering tie, writer-produced names recognized by the exported contract, and exact event-sequence equality across both day-boundary and `OBSERVABILITY_EVENT_SEGMENT_BYTES` rotations. |
| `C2` | type integrity | `shell` | `bun run typecheck` from repository root; local Bun environment | Exit 0. Exported ArkType schemas and their inferred unions remain one type/value source; exhaustive consumers compile without `any`, anonymous loose event shapes, non-boundary `unknown`, or non-const `as` assertions introduced by this change. |
| `C3` | full regression | `shell` | `bun test` from repository root; local Bun environment | Exit 0 with no failed tests. Existing tests are not removed, skipped, or weakened; the prior rotation query test may be renamed only if its assertions are strengthened to the new contract. |
| `C4` | real daemon rotation path | `shell` | `ROOT="$(mktemp -d /tmp/coder-loop-573-runtime.XXXXXX)"; env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon up --loop-data-root "$ROOT" --json; env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon down --loop-data-root "$ROOT" --json; touch -t 202607102200 "$ROOT/events/events.jsonl"; env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon up --loop-data-root "$ROOT" --json; env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon down --loop-data-root "$ROOT" --json; dd if=/dev/zero bs=1048576 count=32 2>/dev/null | tr '\\000' ' ' >> "$ROOT/events/events.jsonl"; env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon up --loop-data-root "$ROOT" --json; env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon down --loop-data-root "$ROOT" --json` from repository root, followed in the same local root by a `bun -e` consumer importing only the exported contract to discover, order, parse, and compare the stream | Every daemon command exits 0; readiness is a successful `daemon up` JSON response and live socket before consumption; exported discovery reports two ordered history segments followed by active; parsed lifecycle sequence matches the writer sequence exactly with equal total and unique counts; all daemon PIDs are absent after stop. Preserve raw command/output evidence and remove the temporary root after capture. |
| `C5` | project canonical E2E | `shell` | `bun scripts/real-e2e.ts` from repository root with configured `gh`/runner CLIs and its isolated loop-data root | Exit 0; fixture PR is MERGED and fixture issue is CLOSED. This is the repository-mandated real daemon/agent path and proves the events-contract change did not break scheduling, while `C4` is the feature-specific runtime proof. |

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| `P1` | `whole-tree` | `Observability(Kind|EventType|Event)Boundary` | Canonical definitions/exports in `src/observability.ts`; imports/usages in tests and same-repository consumers | Exactly one ArkType definition for each schema. Exported runtime schemas and inferred `ObservabilityKind` / `ObservabilityEventType` / `ObservabilityEvent` types derive from those same definitions; no copied event union or envelope shape. |
| `P2` | `whole-tree` | `randomUUID|rotatedObservabilityEventSegment|listObservabilityEventSegments|activeObservabilityEventBasename|events-.*jsonl` | One canonical segment-contract implementation in `src/observability.ts`; focused fixtures/assertions in `src/observability.test.ts` | Active recognition, history parsing/discovery, naming and comparison are exported typed functions/ADTs. Async and sync writers call that same implementation. No second regex, filename template, or independent lexical sort remains in production code. Random UUID is not the ordering key; any retained uniqueness component is separate from the exported deterministic order key. |
| `P3` | `whole-tree` | `OBSERVABILITY_EVENT_SEGMENT_BYTES|shouldRotateObservabilityEventStream` | One definition/decision path in `src/observability.ts`; direct test imports/usages in `src/observability.test.ts` | Day and size rotation share one decision contract, and both async/sync write paths use it. Tests exercise both real triggers rather than reimplementing the predicate. |
| `P4` | `changed` | added-line scan for `\bany\b|\bunknown\b|\bas\b` | `unknown` only at external parse/catch boundaries already required by project rules; `as const` only | No new `any`, true `as` assertion, anonymous loose event object, or internal `unknown`. External JSON/file input is parsed through the exported ArkType boundary before precise internal flow. |

## Canonical runtime

- Setup: clean current `main`, `bun install --frozen-lockfile`, Bun 1.3.x, and configured local `gh`, `codex`/declared runner CLIs for the repository E2E.
- Start: feature runtime uses `env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon up --loop-data-root "$ROOT" --json` against a fresh local `/tmp` root; canonical full-loop driver is `bun scripts/real-e2e.ts`.
- Readiness: `daemon up` exits 0 with JSON success and `$ROOT/daemon.sock` exists before reading events.
- Behavior: drive baseline, day-boundary rotation, and 32 MiB rotation through the real daemon writer; consume only via the newly exported segment/schema contract and assert ordered parsed events are complete and unique. Then run the full fixture E2E.
- Logs: capture daemon up/down JSON, discovered typed segments, ordered event types/counts, equality/uniqueness assertions, process cleanup, and `scripts/real-e2e.ts` terminal fixture URLs under the issue evidence directory.
- Stop ownership: the iteration agent owns every isolated daemon it starts, calls `daemon down` for each root, verifies spawned PIDs are gone, and removes only its own temporary roots after evidence capture. `scripts/real-e2e.ts` owns its isolated daemon/tripwire teardown.

## Test delta

`required`

Add contract-focused tests for deterministic total order, same-day/tie handling, writer/consumer single-source naming, and lossless/duplicate-free day and size rotations. Integrity rule: preserve all existing behavioral coverage and assertion strength; tests may be renamed or refactored only when the replacement asserts a strict superset. Do not lower the 32 MiB contract, mock away writer rotation, sort expected data with the implementation under test, skip cases, or weaken exact sequence equality to counts/set equality.

## Dependencies

- No implementation blocker is declared by #573 (`Depends on: 无`), and current local/source inspection found none.
- #544 is the architecture authority: events JSONL is a same-repository, same-version gateway exception to the general prohibition on scraping runtime files; the exported surface is not a general API for supervisors, agents, or scripts. Source: https://github.com/mouriya-s-lab/coder-loop/issues/544
- #577 is open and blocked on this contract; it is the intended gateway consumer and must import rather than copy segment/schema facts. Source: https://github.com/mouriya-s-lab/coder-loop/issues/577
- Historical PR #654 is closed, unmerged, and explicitly superseded by a fresh current-main contract-enrichment run. It is investigation history only, not a branch/cherry-pick source: https://github.com/mouriya-s-lab/coder-loop/pull/654
- Repository rules require real runtime proof. `src/observability.ts` is the implementation locus; `src/observability.test.ts` currently has only a day-rotation query test and does not yet declare stable multi-segment total order or size-rotation continuity.

## Supersedes

`none`



### comment #4954409084 by `RiriAgent` — 2026-07-13T04:23:15Z

<!-- coder-loop:executable-contract schema=1 source-issue=573 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/573
- Observed body update timestamp: `2026-07-02T14:02:18Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/573#issuecomment-4866583408
- Inherited architecture source: https://github.com/mouriya-s-lab/coder-loop/issues/544
- Downstream consumer source: https://github.com/mouriya-s-lab/coder-loop/issues/577
- Re-enrichment evidence: https://github.com/mouriya-s-lab/coder-loop/pull/671#issuecomment-4954377981 proves the prior marker's foreground `daemon up` command could never reach its later lifecycle steps and identifies the remaining legacy-tie ordering deviation.
- Current-source observation: base `main@f01560d5d0b324e791db7f599e502f09fc78a652`; current implementation PR #671 head `2be6ef0fc0da3cf1de96869b448e80b156ccb99e`. The head exports the schema/segment contract and introduces explicit sequence ordering, but `orderObservabilityEventSegments` currently rejects two valid legacy names with identical timestamps instead of producing the issue-required total order.

## Deliverable

`implementation-pr`

Continue the existing PR https://github.com/mouriya-s-lab/coder-loop/pull/671; it alone closes #573. It exports the same-repository events-consumption contract from `src/observability.ts` and pins it with tests. It does not implement #577's gateway reader, change event vocabulary/emission sites, change `logs --follow`, or change the daemon socket protocol.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| `C1` | contract-focused behavior | `shell` | `bun test src/observability.test.ts` from repository root; local Bun environment | Exit 0. Tests cover exported event/schema parsing; discovery and deterministic total ordering of shuffled active/history names; multiple same-day segments; two valid legacy history names with identical `startedAt`/`endedAt` ordered deterministically rather than rejected; writer-produced names recognized by the exported contract; and exact event-sequence equality across day-boundary and `OBSERVABILITY_EVENT_SEGMENT_BYTES` rotations. |
| `C2` | type integrity | `shell` | `bun run typecheck` from repository root; local Bun environment | Exit 0. Exported ArkType schemas and inferred unions remain one type/value source; no `any`, anonymous loose event shape, non-boundary `unknown`, or non-const `as` assertion is introduced. |
| `C3` | full regression | `shell` | `bun test` from repository root; local Bun environment | Exit 0 with no failed tests. Existing tests are not removed, skipped, or weakened; a renamed/refactored test must assert a strict behavioral superset. |
| `C4` | real daemon rotation path | `shell` | From repository root in one local shell, run the literal block below with Bun 1.3.x and `CODER_LOOP_RUN_CRED` removed for operator calls. | Exit 0. Each background owner reaches socket readiness, `daemon status` reports running, `daemon down` succeeds, and `wait` reaps that exact foreground-owner process. Final exported discovery yields history sequences `1,2` then active; parsed event types equal the exact nine-event writer sequence; serialized total and unique counts are both 9; no daemon PID survives. |
| `C5` | project canonical E2E | `shell` | `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` from repository root with configured `gh` and declared runner CLIs | Exit 0; fixture PR is MERGED, fixture issue is CLOSED, and the isolated daemon/fixture/mutex teardown completes. This is repository-level regression proof; `C4` is the feature-specific runtime proof. |

Literal `C4` block:

```sh
ROOT="$(mktemp -d /tmp/coder-loop-573-runtime.XXXXXX)"
run_cycle() {
  env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon up --loop-data-root "$ROOT" --json >>"$ROOT/daemon-up.jsonl" 2>>"$ROOT/daemon-up.stderr" &
  DAEMON_UP_PID=$!
  while [ ! -S "$ROOT/daemon.sock" ]; do
    kill -0 "$DAEMON_UP_PID"
    sleep 0.05
  done
  env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon status --loop-data-root "$ROOT" --json
  env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon down --loop-data-root "$ROOT" --json
  wait "$DAEMON_UP_PID"
}
run_cycle
touch -t 202607102200 "$ROOT/events/events.jsonl"
run_cycle
dd if=/dev/zero bs=1048576 count=32 2>/dev/null | tr '\\000' ' ' >>"$ROOT/events/events.jsonl"
run_cycle
EVENTS_FILE="$ROOT/events/events.jsonl" bun -e '
import { readFile } from "node:fs/promises"
import { discoverObservabilityEventSegments, ObservabilityEventBoundary } from "./src/observability.ts"
const eventsFile = process.env.EVENTS_FILE
if (eventsFile === undefined) throw new Error("EVENTS_FILE is required")
const segments = await discoverObservabilityEventSegments(eventsFile)
const shape = segments.map((segment) => segment.kind === "history" ? segment.sequence : segment.kind)
if (JSON.stringify(shape) !== JSON.stringify([1, 2, "active"])) throw new Error(`unexpected segment order ${JSON.stringify(shape)}`)
const events = []
for (const segment of segments) {
  for (const line of (await readFile(segment.path, "utf8")).split("\n")) {
    if (line.trim() !== "") events.push(ObservabilityEventBoundary.assert(JSON.parse(line)))
  }
}
const types = events.map((event) => event.type)
const expected = ["daemon.start", "privileged_op.caller_admission", "daemon.stop", "daemon.start", "privileged_op.caller_admission", "daemon.stop", "daemon.start", "privileged_op.caller_admission", "daemon.stop"]
if (JSON.stringify(types) !== JSON.stringify(expected)) throw new Error(`unexpected event sequence ${JSON.stringify(types)}`)
const serialized = events.map((event) => JSON.stringify(event))
if (serialized.length !== 9 || new Set(serialized).size !== 9) throw new Error("event loss or duplication")
console.log(JSON.stringify({ shape, types, count: serialized.length, unique: new Set(serialized).size }))
'
cat "$ROOT/daemon-up.jsonl"
test ! -s "$ROOT/daemon-up.stderr"
test ! -S "$ROOT/daemon.sock"
rm -rf "$ROOT"
```

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| `P1` | `whole-tree` | `Observability(Kind|EventType|Event)Boundary` | Canonical definitions/exports in `src/observability.ts`; imports/usages in tests and same-repository consumers | Exactly one ArkType definition for each schema. Runtime schemas and inferred `ObservabilityKind` / `ObservabilityEventType` / `ObservabilityEvent` types derive from those same definitions; no copied event union or envelope shape. |
| `P2` | `whole-tree` | `randomUUID|rotatedObservabilityEventSegment|parseObservabilityEventSegmentName|discoverObservabilityEventSegments|orderObservabilityEventSegments|activeObservabilityEventBasename|events-.*jsonl` | One canonical segment-contract implementation in `src/observability.ts`; focused fixtures/assertions in `src/observability.test.ts` | Active recognition, history parsing/discovery, naming and comparison are exported typed functions/ADTs, and async/sync writers call the same implementation. Every valid filename set receives a deterministic total order. New-format causal order comes from explicit sequence, never UUID; legacy equal-timestamp ties use a stable filename/id tie-breaker rather than throwing. No second regex, filename template, or independent production sort remains. |
| `P3` | `whole-tree` | `OBSERVABILITY_EVENT_SEGMENT_BYTES|shouldRotateObservabilityEventStream` | One definition/decision path in `src/observability.ts`; direct test imports/usages in `src/observability.test.ts` | Day and size rotation share one decision contract, and both async/sync write paths use it. Tests exercise both real triggers rather than reimplementing the predicate. |
| `P4` | `changed` | added-line scan for `\bany\b|\bunknown\b|\bas\b` | `unknown` only at external parse/catch boundaries required by project rules; `as const` only | No new `any`, true `as` assertion, anonymous loose event object, or internal `unknown`. External JSON/file input is parsed through the exported ArkType boundary before precise internal flow. |

## Canonical runtime

- Setup: clean PR #671 head derived from current `main`, `bun install --frozen-lockfile`, Bun 1.3.x, and configured local `gh` plus the declared runner CLI for the canonical E2E.
- Start: `C4` starts `daemon up` in the background of the same owning shell, captures `$!`, and retains ownership until `daemon down` plus `wait`; canonical full-loop start is owned by `bun scripts/real-e2e.ts`.
- Readiness: the owning process remains alive and `$ROOT/daemon.sock` exists; `daemon status --json` must then report `running: true` before behavior proceeds.
- Behavior: run baseline, day-boundary rotation, and 32 MiB rotation through the real daemon writer; consume only through exported discovery/schema APIs and assert the exact segment and event sequences. Then run the full fixture E2E.
- Logs: preserve daemon up/status/down output, discovered typed segments, ordered event types/counts, equality/uniqueness assertions, owner-process cleanup, and canonical E2E fixture URLs under the issue evidence directory before removing the temporary runtime root.
- Stop ownership: the same shell that backgrounds each `daemon up` sends `daemon down`, waits for its captured PID, verifies the socket is absent, and removes only its own root. `scripts/real-e2e.ts` owns its isolated daemon, fixture and mutex teardown.

## Test delta

`required`

Add and retain contract-focused tests for deterministic total order, same-day and equal-timestamp legacy ties, writer/consumer single-source naming, and lossless/duplicate-free day and size rotations. Integrity rule: preserve all existing behavioral coverage and assertion strength; tests may be renamed or refactored only when the replacement asserts a strict superset. Do not reject a valid filename set, lower the 32 MiB contract, mock away writer rotation, sort expected data with the implementation under test, skip cases, or weaken exact sequence equality to counts/set equality.

## Dependencies

- No external implementation blocker is declared by #573 (`Depends on: 无`) or found in the current review state.
- #544 is the architecture authority: events JSONL is a same-repository, same-version gateway exception to the general prohibition on scraping runtime files; this export is not a general API for supervisors, agents, or scripts. Source: https://github.com/mouriya-s-lab/coder-loop/issues/544
- #577 is open and blocked on this contract; it is the intended gateway consumer and must import rather than copy segment/schema facts. Source: https://github.com/mouriya-s-lab/coder-loop/issues/577
- PR #671 is the existing implementation route and remains open at head `2be6ef0fc0da3cf1de96869b448e80b156ccb99e`; review must continue there after re-enrichment. Source: https://github.com/mouriya-s-lab/coder-loop/pull/671
- Historical PR #654 is closed and unmerged. It remains investigation history only, not a branch/cherry-pick source: https://github.com/mouriya-s-lab/coder-loop/pull/654
- The verified contract defect and implementation deviation are recorded at https://github.com/mouriya-s-lab/coder-loop/pull/671#issuecomment-4954377981. The next iteration must both use the executable `C4` lifecycle and replace legacy-tie rejection at `src/observability.ts:1228` / `src/observability.test.ts:131` with deterministic ordering coverage.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/573#issuecomment-4953811022



### comment #4954524567 by `RiriAgent` — 2026-07-13T04:46:24Z

<!-- coder-loop:executable-contract schema=1 source-issue=573 -->

## Intent source

- Issue: https://github.com/mouriya-s-lab/coder-loop/issues/573
- Observed body update timestamp: `2026-07-02T14:02:18Z`
- Operator comments used:
  - https://github.com/mouriya-s-lab/coder-loop/issues/573#issuecomment-4866583408
- Inherited architecture source: https://github.com/mouriya-s-lab/coder-loop/issues/544
- Downstream consumer source: https://github.com/mouriya-s-lab/coder-loop/issues/577
- Re-enrichment evidence:
  - https://github.com/mouriya-s-lab/coder-loop/pull/671#issuecomment-4954377981 proves the v1 marker's foreground `daemon up` command could never reach its later lifecycle steps and identifies the legacy-tie ordering deviation.
  - Local run `run-1783916631954-36-iteration-item-5`, `/Users/mouriya/.coder-loop/loop-data/chains/v3-573/runs/run-1783916631954-36-iteration-item-5/iteration/stdout.jsonl` and sibling `status.json`, proves the v2 C4 behavior reached `[1,2,"active"]`, nine exact/unique events and clean PID/socket teardown, but its `test ! -s daemon-up.stderr` rejected normal lifecycle/audit stderr (969 bytes) and therefore made the Check timing-dependent.
  - Before publication, this run (`run-1783917785382-40-contract-enrichment-item-5`) executed the exact v3 C4 block from its phase stdout: exit 0; owner PIDs `24969/24976/24993` were reaped; shape was `[1,2,"active"]`; event count and unique count were both 9; normal lifecycle/audit stderr was printed; the temporary root was removed.
- Current-source observation: base `main@f01560d5d0b324e791db7f599e502f09fc78a652`; current implementation PR #671 head `2be6ef0fc0da3cf1de96869b448e80b156ccb99e`. The worktree contains an uncommitted two-file correction that replaces legacy equal-timestamp rejection with stable filename ordering and a strict-superset test; iteration must preserve, verify and submit that correction on the existing PR.

## Deliverable

`implementation-pr`

Continue the existing PR https://github.com/mouriya-s-lab/coder-loop/pull/671; it alone closes #573. It exports the same-repository events-consumption contract from `src/observability.ts` and pins it with tests. It does not implement #577's gateway reader, change event vocabulary/emission sites, change `logs --follow`, or change the daemon socket protocol.

## Checks

| ID | Dimension | Kind | Command / cwd / env | Expected exit/output |
|---|---|---|---|---|
| `C1` | contract-focused behavior | `shell` | `bun test src/observability.test.ts` from repository root; local Bun environment | Exit 0. Tests cover exported event/schema parsing; discovery and deterministic total ordering of shuffled active/history names; multiple same-day segments; two valid legacy history names with identical `startedAt`/`endedAt` ordered deterministically rather than rejected; writer-produced names recognized by the exported contract; and exact event-sequence equality across day-boundary and `OBSERVABILITY_EVENT_SEGMENT_BYTES` rotations. |
| `C2` | type integrity | `shell` | `bun run typecheck` from repository root; local Bun environment | Exit 0. Exported ArkType schemas and inferred unions remain one type/value source; no `any`, anonymous loose event shape, non-boundary `unknown`, or non-const `as` assertion is introduced. |
| `C3` | full regression | `shell` | `bun test` from repository root; local Bun environment | Exit 0 with no failed tests. Existing tests are not removed, skipped, or weakened; a renamed/refactored test must assert a strict behavioral superset. |
| `C4` | real daemon rotation path | `shell` | From repository root in one local shell, run the literal block below with Bun 1.3.x and `CODER_LOOP_RUN_CRED` removed for operator calls. | Exit 0. Each background owner reaches socket readiness, `daemon status` reports running, `daemon down` succeeds, and `wait` reaps that exact foreground-owner process. Final exported discovery yields history sequences `1,2` then active; parsed event types equal the exact nine-event writer sequence; serialized total and unique counts are both 9; no daemon PID survives. `daemon-up.stderr` is emitted into the transcript as diagnostic evidence and may contain normal lifecycle/audit lines; its non-emptiness is not a failure condition. |
| `C5` | project canonical E2E | `shell` | `bun scripts/real-e2e.ts --fixture-cwd /Users/mouriya/Ext/code/coder-loop-e2e-fixture` from repository root with configured `gh` and declared runner CLIs | Exit 0; fixture PR is MERGED, fixture issue is CLOSED, and the isolated daemon/fixture/mutex teardown completes. This is repository-level regression proof; `C4` is the feature-specific runtime proof. |

Literal `C4` block:

```sh
set -e
ROOT="$(mktemp -d /tmp/coder-loop-573-runtime.XXXXXX)"
run_cycle() {
  env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon up --loop-data-root "$ROOT" --json >>"$ROOT/daemon-up.jsonl" 2>>"$ROOT/daemon-up.stderr" &
  DAEMON_UP_PID=$!
  while [ ! -S "$ROOT/daemon.sock" ]; do
    kill -0 "$DAEMON_UP_PID"
    sleep 0.05
  done
  env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon status --loop-data-root "$ROOT" --json
  env -u CODER_LOOP_RUN_CRED bun src/loop.ts daemon down --loop-data-root "$ROOT" --json
  wait "$DAEMON_UP_PID"
}
run_cycle
touch -t 202607102200 "$ROOT/events/events.jsonl"
run_cycle
dd if=/dev/zero bs=1048576 count=32 2>/dev/null | tr '\000' ' ' >>"$ROOT/events/events.jsonl"
run_cycle
EVENTS_FILE="$ROOT/events/events.jsonl" bun -e '
import { readFile } from "node:fs/promises"
import { discoverObservabilityEventSegments, ObservabilityEventBoundary } from "./src/observability.ts"
const eventsFile = process.env.EVENTS_FILE
if (eventsFile === undefined) throw new Error("EVENTS_FILE is required")
const segments = await discoverObservabilityEventSegments(eventsFile)
const shape = segments.map((segment) => segment.kind === "history" ? segment.sequence : segment.kind)
if (JSON.stringify(shape) !== JSON.stringify([1, 2, "active"])) throw new Error(`unexpected segment order ${JSON.stringify(shape)}`)
const events = []
for (const segment of segments) {
  for (const line of (await readFile(segment.path, "utf8")).split("\n")) {
    if (line.trim() !== "") events.push(ObservabilityEventBoundary.assert(JSON.parse(line)))
  }
}
const types = events.map((event) => event.type)
const expected = ["daemon.start", "privileged_op.caller_admission", "daemon.stop", "daemon.start", "privileged_op.caller_admission", "daemon.stop", "daemon.start", "privileged_op.caller_admission", "daemon.stop"]
if (JSON.stringify(types) !== JSON.stringify(expected)) throw new Error(`unexpected event sequence ${JSON.stringify(types)}`)
const serialized = events.map((event) => JSON.stringify(event))
if (serialized.length !== 9 || new Set(serialized).size !== 9) throw new Error("event loss or duplication")
console.log(JSON.stringify({ shape, types, count: serialized.length, unique: new Set(serialized).size }))
'
cat "$ROOT/daemon-up.jsonl"
cat "$ROOT/daemon-up.stderr"
test ! -S "$ROOT/daemon.sock"
rm -rf "$ROOT"
```

## Pattern scope

| ID | Scope | Pattern / query | Allowed sites | Expected convergence |
|---|---|---|---|---|
| `P1` | `whole-tree` | `Observability(Kind|EventType|Event)Boundary` | Canonical definitions/exports in `src/observability.ts`; imports/usages in tests and same-repository consumers | Exactly one ArkType definition for each schema. Runtime schemas and inferred `ObservabilityKind` / `ObservabilityEventType` / `ObservabilityEvent` types derive from those same definitions; no copied event union or envelope shape. |
| `P2` | `whole-tree` | `randomUUID|rotatedObservabilityEventSegment|parseObservabilityEventSegmentName|discoverObservabilityEventSegments|orderObservabilityEventSegments|activeObservabilityEventBasename|events-.*jsonl` | One canonical segment-contract implementation in `src/observability.ts`; focused fixtures/assertions in `src/observability.test.ts` | Active recognition, history parsing/discovery, naming and comparison are exported typed functions/ADTs, and async/sync writers call the same implementation. Every valid filename set receives a deterministic total order. New-format causal order comes from explicit sequence, never UUID; legacy equal-timestamp ties use a stable filename/id tie-breaker rather than throwing. No second regex, filename template, or independent production sort remains. |
| `P3` | `whole-tree` | `OBSERVABILITY_EVENT_SEGMENT_BYTES|shouldRotateObservabilityEventStream` | One definition/decision path in `src/observability.ts`; direct test imports/usages in `src/observability.test.ts` | Day and size rotation share one decision contract, and both async/sync write paths use it. Tests exercise both real triggers rather than reimplementing the predicate. |
| `P4` | `changed` | added-line scan for `\bany\b|\bunknown\b|\bas\b` | `unknown` only at external parse/catch boundaries required by project rules; `as const` only | No new `any`, true `as` assertion, anonymous loose event object, or internal `unknown`. External JSON/file input is parsed through the exported ArkType boundary before precise internal flow. |

## Canonical runtime

- Setup: clean PR #671 head derived from current `main`, `bun install --frozen-lockfile`, Bun 1.3.x, and configured local `gh` plus the declared runner CLI for the canonical E2E.
- Start: `C4` starts `daemon up` in the background of the same owning shell, captures `$!`, and retains ownership until `daemon down` plus `wait`; canonical full-loop start is owned by `bun scripts/real-e2e.ts`.
- Readiness: the owning process remains alive and `$ROOT/daemon.sock` exists; `daemon status --json` must then report `running: true` before behavior proceeds.
- Behavior: run baseline, day-boundary rotation, and 32 MiB rotation through the real daemon writer; consume only through exported discovery/schema APIs and assert the exact segment and event sequences. Then run the full fixture E2E.
- Logs: preserve daemon up stdout and normal diagnostic stderr, status/down output, discovered typed segments, ordered event types/counts, equality/uniqueness assertions, owner-process cleanup, and canonical E2E fixture URLs under the issue evidence directory before removing the temporary runtime root.
- Stop ownership: the same shell that backgrounds each `daemon up` sends `daemon down`, waits for its captured PID, verifies the socket is absent, and removes only its own root. `scripts/real-e2e.ts` owns its isolated daemon, fixture and mutex teardown.

## Test delta

`required`

Add and retain contract-focused tests for deterministic total order, same-day and equal-timestamp legacy ties, writer/consumer single-source naming, and lossless/duplicate-free day and size rotations. Integrity rule: preserve all existing behavioral coverage and assertion strength; tests may be renamed or refactored only when the replacement asserts a strict superset. Do not reject a valid filename set, lower the 32 MiB contract, mock away writer rotation, sort expected data with the implementation under test, skip cases, or weaken exact sequence equality to counts/set equality.

## Dependencies

- No external implementation blocker is declared by #573 (`Depends on: 无`) or found in the current review state.
- #544 is the architecture authority: events JSONL is a same-repository, same-version gateway exception to the general prohibition on scraping runtime files; this export is not a general API for supervisors, agents, or scripts. Source: https://github.com/mouriya-s-lab/coder-loop/issues/544
- #577 is open and blocked on this contract; it is the intended gateway consumer and must import rather than copy segment/schema facts. Source: https://github.com/mouriya-s-lab/coder-loop/issues/577
- PR #671 is the existing implementation route and remains open at head `2be6ef0fc0da3cf1de96869b448e80b156ccb99e`; review must continue there after re-enrichment. Source: https://github.com/mouriya-s-lab/coder-loop/pull/671
- Historical PR #654 is closed and unmerged. It remains investigation history only, not a branch/cherry-pick source: https://github.com/mouriya-s-lab/coder-loop/pull/654
- The first verified contract defect and implementation deviation are recorded at https://github.com/mouriya-s-lab/coder-loop/pull/671#issuecomment-4954377981. The second defect is recorded by local run `run-1783916631954-36-iteration-item-5`: normal daemon lifecycle/audit stderr is evidence to retain, not an emptiness invariant. The same run left the required deterministic legacy-tie correction uncommitted in `src/observability.ts` and `src/observability.test.ts`; the next iteration must continue from those preserved changes on PR #671.

## Supersedes

https://github.com/mouriya-s-lab/coder-loop/issues/573#issuecomment-4954409084



### comment #4954805721 by `RiriAgent` — 2026-07-13T05:44:38Z

## Coder-loop closure review (run-1783919204171-49-review-item-5)

Review verified this issue is fully handled.

- Acceptance criteria: independently replayed; C1–C5 all matched at PR head, and C4/C5 matched again through the recreatable manifest.
- Child/subtask issues: none; the live sub-issue graph is empty.
- Final transition made by coder-loop review.

Reason:
PR #671 converges the exported event/schema and segment-order contract, gives legacy equal-timestamp segments a deterministic filename/id tie-breaker, preserves test integrity, and passes the real daemon rotation path plus the repository canonical daemon/runner/GitHub E2E. The PR was squash-merged only after diff-audit, replay, protocol, evidence, and closure gates passed.



---

## Timeline (20)

- 2026-07-02T12:02:02Z `assigned` @RiriAgent
- 2026-07-02T12:02:51Z `cross-referenced` @RiriAgentsrc=576
- 2026-07-02T12:02:52Z `cross-referenced` @RiriAgentsrc=577
- 2026-07-02T14:01:50Z `parent_issue_added` @RiriAgent
- 2026-07-02T14:02:18Z `commented` @RiriAgent
- 2026-07-02T14:02:40Z `cross-referenced` @RiriAgentsrc=544
- 2026-07-11T23:30:14Z `cross-referenced` @RiriAgentsrc=654
- 2026-07-13T02:11:19Z `commented` @RiriAgent
- 2026-07-13T03:27:38Z `cross-referenced` @RiriAgentsrc=671
- 2026-07-13T04:23:15Z `commented` @RiriAgent
- 2026-07-13T04:46:24Z `commented` @RiriAgent
- 2026-07-13T05:03:52Z `referenced` @RiriAgentcommit=9a3140ff1a841b82216f456f51b95d7a32e535dd
- 2026-07-13T05:44:23Z `referenced` @RiriAgentcommit=a3ff0e9ce64c5a55feed029dee3e07a5b7b3cb8d
- 2026-07-13T05:44:23Z `closed` @RiriAgentcommit=None
- 2026-07-13T05:44:38Z `commented` @RiriAgent
- 2026-07-16T23:38:35Z `referenced` @RiriAgentcommit=05ee53cc42027da2343ce5f24c5a0103e919fdb8
- 2026-07-17T20:36:31Z `cross-referenced` @RiriAgentsrc=716
- 2026-07-17T20:36:36Z `cross-referenced` @RiriAgentsrc=718
- 2026-07-17T20:36:40Z `cross-referenced` @RiriAgentsrc=720
- 2026-07-17T20:38:41Z `cross-referenced` @RiriAgentsrc=721