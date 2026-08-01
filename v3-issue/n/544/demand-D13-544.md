# RFC #544 R10 / D13 — mesh 移动端与 PWA 原子需求

> 输入边界：只读 AGG D13、固定架构、`expected-foundation-544.md` 与 D5/D7/D8 需求接缝。本报告不读取源码、不拆 implementation issue，也不把真机与浏览器运行未知升级为新地基机制。

## A. 主 agent 摘要

D13 只收口现有 Web GUI 的移动形态：手机通过 NetBird mesh 访问与桌面端相同的应用、相同的 routes 和相同的 typed 数据/控制面。它不建立原生应用或移动专用实现。PWA 必须有有效 manifest、安装所需图标与 service worker，能被真机加入主屏并以 standalone 窗口启动；不承诺离线读取、离线 mutation、后台同步或离线控制。

移动首屏必须在无需滚动的初始视口内优先显示 daemon 三证、active runs、异常清单和控制动作，且无横向溢出。深层 D7/D8/D9 页面仍可从同一路由到达，但不能挤占首屏。D7 生命周期动作以及 D8 的 unblock、chain stop/resume、item reorder 必须可触达、适合触控并真实生效，结果与失败仍由既有 typed façade 呈现。

CAP-4 不因移动端而改变：只有 daemon 返回当前 operator 对指定 evaluation identity 的 capability 时，页面才显示允许的 `advance | hold | reopen` decision；没有 capability 时只能显示 authority gap。移动 UI 不推导 authority，也不以 resume、unblock 或 join 修改冒充 decision。

网络与信任边界沿用 D5/F26：网关只监听 loopback 与明确的 NetBird interface；不得监听 LAN、公网、`0.0.0.0`、`[::]` 或通配地址。mesh 内访问不新增 token、登录、SSO 或应用层鉴权，gateway 继续作为既定 operator 主体，daemon 继续是 socket mutation 的唯一裁判。

共 **15** 项原子需求：预期地基直接供给 **5** 项，D13 自建 **10** 项，真正地基缺口 **0**。U10、U14、U15 是真机、浏览器、mesh 与生命周期路径的运行证明输入，不是新增合同。完成证据必须来自真实 NetBird 手机：打开网关、安装、主屏 standalone 启动、核对首屏并执行至少一个控制动作；同时验证精确监听边界与桌面端不回归。

## B. 原子需求矩阵

### B1. 预期地基直接供给

| ID | 原子保证 | 稳定来源 | F/X 映射 | 归属 | 可证伪观察 | 运行未知 |
|---|---|---|---|---|---|---|
| **D13-R01** | 移动端显示的 status、daemon 三证、active run 与异常来自既有精确边界；三证不折成单 boolean，status/events 不拼成虚构的全局 snapshot | AGG 3.1、3.2；D7 性质 1/5 | F01–F06、F11–F15，X07 | **地基直接供给** | 手机上的三证、active run、异常与同次 canonical status/events 输入一致；非法 wire 被拒绝 | U01–U05、U08–U10 |
| **D13-R02** | daemon start/stop/restart 在移动端复用 D7 生命周期机制：start 由 gateway spawn，stop/restart 经 typed socket；成功以三证翻绿核验 | AGG D7 性质 4；D13 性质 3 | F06–F10、F25–F27，X02 | **地基直接供给** | daemon-down 时 start 可用；stop/restart 的 accepted/rejected/failed 可区分；成功后三证分别核验 | U06、U07、U15 |
| **D13-R03** | unblock、chain stop/resume、item reorder 复用 D8 的 exact F façade、daemon 裁决与 status/events 核验，不复制移动端 mutation client/schema | AGG 3.3；D8 性质 1–4；D13 性质 3 | F03–F05、F07–F09、F11、F15、F25–F27，X02、X03、X06 | **地基直接供给** | 手机上每个 verb 的 accepted/rejected/failed 与 transport error 保持 typed；成功后 canonical status/events 可核验 | U07、U10、U14 |
| **D13-R04** | CAP-4 identity、capability、decision ADT、真实 consumer 与 status/event/audit 对齐沿用同一 F façade | AGG CAP-4；D8 性质 1；D13 性质 3 | F28–F30，X01、X02、X03、X06 | **地基直接供给** | capable、无 capability、stale identity 三条路径保持不同；accepted decision 被 evaluator 消费并以同 identity 观察 | U07、U14 |
| **D13-R05** | 移动访问沿用既定 operator 信任模型：无应用层认证；socket mutation 仍由 daemon 裁决，start 仍按 F10 分流 | AGG 3.1；D5 定义；D8 性质 4 | F10、F26 | **地基直接供给** | mesh 手机无需登录/token 即可加载；gateway 不新增 authority 判断，daemon rejection 原样呈现 | U14、U15 |

### B2. D13 自身建立

| ID | 原子保证 | 稳定来源 | F/X 映射 | 归属 | 可证伪观察 | 运行未知 |
|---|---|---|---|---|---|---|
| **D13-R06** | 真实手机可经 NetBird IP 直接到达生产 gateway listener，加载同一构建静态资产、routes、status 与 SSE | AGG 3.1；D5 C7；D13 真机全流程 | F04、F05、F14 | **D13 自建** | mesh 真机浏览器直接打开 NetBird 地址；请求落到 NetBird listener，页面/status/SSE 可用 | U10、U14 |
| **D13-R07** | 监听严格限制为 loopback 与明确 NetBird interface；LAN、公网、通配、`0.0.0.0`、`[::]` 均不可达 | AGG D5 定义、C8；固定架构 | 无新增 F；消费 F26 的信任边界 | **D13 自建** | `lsof` 只见两类精确监听；mesh peer 成功，LAN curl 失败，无代理/公网旁路 | U10 |
| **D13-R08** | 手机与桌面使用同一个响应式应用、同一 route graph、同一 server/data/mutation client；不存在移动专用第二实现 | AGG 3.2；D13 性质 4 | F04、F05、F25、X01、X02、X06 | **D13 自建** | 同一 URL 在移动/桌面 viewport 渲染；route 与网络请求集合无 mobile-only 分叉或重复 schema | U10、U14 |
| **D13-R09** | Web 应用提供有效 manifest、安装所需图标与 service worker，满足目标真机浏览器的 PWA installability 条件 | AGG D13 性质 1 | 无新增 F；复用 D5 同 PID 静态资产宿主 | **D13 自建** | 真机浏览器认定可安装，manifest/icon/service-worker 请求均来自同一 gateway 且成功 | U10 |
| **D13-R10** | 用户可将 PWA 加入主屏，并从主屏以 standalone display mode 启动到同一应用与 route | AGG D13 性质 1、真机全流程 | 无新增 F | **D13 自建** | 完成真机安装；关闭浏览器后从主屏图标打开，显示 standalone 窗口且身份/数据未换源 | U10 |
| **D13-R11** | 移动初始视口无需滚动即可同时看到 daemon 三证、active runs、异常清单与控制动作，且无横向溢出 | AGG 3.2；D13 性质 2、移动首屏验收 | F04–F06、F11–F15、F25 | **D13 自建** | 目标真机首屏截图中四类内容完整在 viewport 内；横向 scroll width 不超过 viewport | U10、U14 |
| **D13-R12** | 深层 D7/D8/D9 信息仍从移动首屏经同一路由可达，但不占据首屏优先区 | AGG 3.2；D13 性质 2/4 | F03–F05、F11、F15、F25 | **D13 自建** | 从手机首屏进入 daemon、chain/item/run 与控制详情，再返回首屏；初始 viewport 未被深层详情挤出 | U10、U14 |
| **D13-R13** | D7/D8 全部控制入口在手机上可触达、适合触控并可提交；明确结果、拒绝与失败不被 responsive layer 吞掉 | AGG D13 性质 3；D7/D8 验收 | F07–F10、F25–F27，X02、X03、X06 | **D13 自建** | 真机遍历 lifecycle 与四 verb；至少执行一个真实动作并以 status/events 核验，失败路径可读 | U07、U10、U14、U15 |
| **D13-R14** | CAP-4 控件按 capability 条件渲染：有 capability 仅显示允许 decision；无 capability 只显示 authority gap，且移动布局不泄露不可用 submit | AGG D13 性质 3；CAP-4 | F28–F30，X01、X02、X03、X06 | **D13 自建** | 真机分别观察 capable/无 capability/stale 三态；无 capability 时 DOM/route 均无可提交 decision | U10、U14 |
| **D13-R15** | 响应式/PWA 收口不得使桌面 D7/D8/D9 主要页面、路由或控制行为回归 | AGG D13 PC 不回归验收 | F03–F15、F25–F30，X01–X03、X06 | **D13 自建** | PC viewport 完整走查 D7/D8/D9；布局、读取、SSE 与控制动作保持可用 | U10、U14、U15 |

### B3. 计数与地基判定

| 分类 | 需求 | 数量 | 判定 |
|---|---|---:|---|
| 预期地基直接供给 | D13-R01–R05 | **5** | D13 消费 status、三证、events、typed mutation、生命周期与 CAP-4，不重造领域合同 |
| D13 自身建立 | D13-R06–R15 | **10** | mesh/监听、响应式同构、PWA 安装、首屏布局、移动交互与 PC 回归 |
| 真正地基未闭合 | 无 | **0** | U10/U14/U15 等是运行证明未知，不是合同缺口 |
| 原子需求总计 | D13-R01–R15 | **15** | 可进入后续阶段，但本报告不拆 issue |

### B4. identity、类型、响应式与安全边界

#### Identity 与类型

- 手机与桌面消费同一 engine-owned status boundary、同一 event ADT、同一 typed transport 和同一 F façade；responsive view 不能引入平行 DTO、parser、mutation schema 或 command 字符串表。
- daemon lifecycle 请求绑定同一 loop-data root；start 的完成以该 daemon 的三证翻绿为准，不以 spawn 返回或 toast 为准。
- CAP-4 route/UI 携带完整 `(parId, epoch, bindingVersion)`，capability 与 submit 均由 daemon 对当前 operator 重验；移动端不按 “latest” 猜 identity。
- status、events 与 audit 是独立事实面。动作核验要求 identity 可关联，不要求跨介质共同 commit 或全局时钟。

#### 响应式边界

- “同一应用”意味着同一 route graph、数据 client、mutation client、组件语义与构建产物；CSS/layout 的 breakpoint 差异不构成第二实现。
- “首屏无需滚动”只约束初始移动 viewport 中的四类优先信息，不要求所有详情都塞入一屏。
- 深层浏览保持可达；移动导航可以改变排布和控件形态，但不得改变动作集合、结果 ADT 或 authority 语义。

#### 网络与信任边界

- 可达面仅为 loopback 与明确 NetBird interface；NetBird mesh 是网络准入边界，不扩展到 LAN 或公网。
- 不新增 login、token、SSO、cookie session 或应用层 identity。gateway 沿既定 operator 主体调用，daemon 继续裁决 socket mutation。
- 无 capability 是领域 authority gap，不是登录失败；UI 不提示用户取得 token，也不生成替代授权路径。

### B5. 真机与浏览器验证矩阵

| 场景 | 环境与操作 | 必须观察 | 不能替代 |
|---|---|---|---|
| 精确网络入口 | operator Mac 启动 gateway；检查 listener；NetBird 手机访问；LAN peer/curl 反测 | 仅 loopback + NetBird IP 监听；mesh 成功，LAN/通配/公网失败 | 本机 localhost curl、代理转发或 `0.0.0.0` |
| PWA 安装 | 真机浏览器打开 NetBird URL并执行安装 | 浏览器判定可安装；manifest/icon/service worker 均成功 | DevTools manifest 截图或桌面安装 |
| 主屏启动 | 关闭浏览器，从手机主屏图标打开 | standalone 窗口、同一 route、真实 status 数据 | 浏览器书签或普通 tab |
| 移动首屏 | 准备 active run、异常与 daemon 三证后打开 | 无滚动看到三证、active run、异常、控制动作；无横向溢出 | shell HTML、mock page、只测 viewport width |
| 深层可达 | 从首屏进入 D7/D8/D9 页面后返回 | 同 routes 可达，数据与动作语义不变 | mobile-only detail page |
| 生命周期 | daemon-down 手机点击 start；活态 stop/restart | typed 结果；start/restart 后三证分别翻绿；gateway/daemon 生命周期解耦 | toast、pid 单证或 start RPC |
| F 四动作 | 手机上遍历 unblock、stop、resume、reorder，执行可用 fixture | 触控可达；accepted/rejected/failed 明确；成功由 status/events 核验 | 仅检查按钮存在 |
| CAP-4 | capable 与无 capability fixture 各打开一次 | capable 时仅允许 decision；无 capability 只显示 authority gap | 静态隐藏、resume/unblock 替代 decision |
| SSE/daemon-down | 手机已开页面时停止 daemon、断开再恢复 mesh | daemon-down 页面/历史仍服务；mesh 断开表现为 gateway 不可达；资源恢复后页面可重新使用 | 把 RPC failure 当网络 failure |
| PC 回归 | PC viewport 走查 D7/D8/D9 主要 routes 与动作 | 布局、status、SSE、mutation 均无回归 | 仅跑 typecheck/unit test |

### B6. 仍未证明但不构成地基缺口

| 未知 | D13 后续运行证明 | 不得推出 |
|---|---|---|
| **U10** 真实浏览器 SSE 在 daemon kill、client abort 与 mesh 链路下的资源行为 | 真机 mesh、daemon-down、断链/恢复与 SSE 资源清理 | replay、`Last-Event-ID`、restart cursor、server caps |
| **U14** 四 mutation 与 CAP-4 decision 的真实 HTTP/浏览器/status/events/audit 全路径 | 真机操作 fixture，逐动作记录结果及 canonical 核验 | 平行 mobile client、共同 commit、outbox、durable operation |
| **U15** gateway spawn、进程脱离、stop/restart 与三证翻绿 | 真机 lifecycle E2E，并终止/re启 gateway 验证 daemon 独立 | 通用 supervisor、start RPC |
| 目标真机浏览器的 installability 与 standalone 行为 | 在交付目标手机/浏览器真实安装并从主屏启动 | 原生壳、第二移动应用或离线 mutation |
| NetBird 地址漂移与实际接口绑定 | 运行时读取并显式配置当前 NetBird IP，再复核 listener | 放宽为 `0.0.0.0`、LAN 或通配监听 |

### B7. 明确排除

1. 不创建原生应用、原生壳、移动专用 routes/components 或第二套移动实现。
2. 不承诺离线读取、离线 mutation queue、background sync、离线控制或断线重放。
3. 不引入 token、登录、SSO、应用层认证、cookie session 或 identity 重设计。
4. 不开放公网/LAN ingress，不监听 `0.0.0.0`、`[::]`、通配或 LAN 地址。
5. 不增加 server/response byte caps、connection caps、server idle/handler deadline。
6. 不建立额外 process supervisor，也不让 gateway 托管 daemon 生命周期。
7. 不复制 mobile mutation client、wire schema、command registry、status builder 或 CAP-4 authority 规则。
8. 无 capability 时不显示或提交 CAP-4 decision，不用其他 mutation 冒充。
9. 不引入 durable operation、query/replay、outbox、saga、共同 commit、exactly-once 或第二审计日志。

## C. 证据索引

- `AGG-544-gui-observability-gateway.md:83-118`：固定架构、信息架构、F 档闭集。
- `AGG-544-gui-observability-gateway.md:250-284`：D5 精确 listener、同 PID 静态资产、真实移动/mesh 浏览器与网络收窄。
- `AGG-544-gui-observability-gateway.md:319-362`：D7/D8 首屏、生命周期、mutation 与 CAP-4 接缝。
- `AGG-544-gui-observability-gateway.md:446-464`：D13 稳定定义与验收。
- `expected-foundation-544.md:23-51,72-98`：F01–F15、F25–F30 与 X01/X02/X03/X06/X07。
- `expected-foundation-544.md:100-118`：U10、U14、U15 等运行未知。
- `demand-D05-544.md`、`demand-D07-544.md`、`demand-D08-544.md`：网关 listener、daemon 生命周期、F façade 与 CAP-4 的相邻需求边界。
