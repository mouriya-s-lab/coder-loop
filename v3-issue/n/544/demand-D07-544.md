# RFC #544 R10 / D7 — daemon 活性首屏与生命周期闭环原子需求

> 需求事实源仅为 AGG D7、`expected-foundation-544.md` 与纠偏后的 S1/S2 摘要。本报告定义 GUI 所需的最小观测与生命周期结果，不选择transport、probe或process实现，不新增process supervisor、server caps、认证体系或三证原子采样。

## A. 一页摘要

D7 要让操作员在首屏一眼区分四类事实：

1. daemon 的三条独立证据：pid文件/进程、socket connect、身份匹配的`daemon.status`；
2. daemon 死态下仍可读的队列终态、events历史、最后事件时间与死因线索；
3. daemon死亡与网关/mesh断网的区别；
4. 每chain活run/最近转移、精确`rateLimit`冷却和最近具名异常。

生命周期闭环固定为：死态start由gateway spawn `coder-loop daemon up`，不是RPC；stop/restart走既定机制；spawn daemon与gateway生命周期解耦；成功restart后三证翻绿。D7不因此拥有通用process supervisor，也不要求三证来自同一原子时点。

共形成 **13项原子需求 D07-R01–R13**：既有地基直接供给5项，D7自身建立8项，地基缺口0。三证采样、strict status、events与typed transport分别复用F01–F15；D7只负责同屏呈现、断网判别、生命周期交互和闭环观察，不建立第二套健康推断。

验收必须走真实浏览器：活态、死态、pid活/socket死等分裂态、mesh断开、死态start、stop、restart、gateway退出后daemon仍活。运行未知U05/U06/U08–U10/U14/U15只决定fixture和参数，不新增caps、认证或supervisor需求。

## B. 原子需求矩阵

### B1. 需求、供给与所有权

| 需求 ID | 原子需求 | 稳定来源 | F / X 映射 | Owner / 分类 | 验证时必须观察 | 仍未知 |
|---|---|---|---|---|---|---|
| **D07-R01** | 提供pid证据：pid文件存在/读取/解析结果、该pid采样时是否可signal及精确失败分类；不以`ps`启发式冒充身份 | D7三证第1项 | F06 | **地基直接供给，D7消费** | absent、malformed、ESRCH、EPERM/success分别可见，保留采样时间 | U05 |
| **D07-R02** | 提供socket connect证据，与RPC结果分槽：成功或精确connect失败及采样时间 | D7三证第2项 | F06、F07 | **地基直接供给，D7消费** | socket absent/refused/success可区分；connect成功后RPC失败不覆盖connect正证 | U05、U06 |
| **D07-R03** | 提供一次有界、完整、合法、request/response identity匹配的typed `daemon.status`结果或精确failure；deadline/abort销毁socket | D7三证第3项；D5 typed client | F07–F09 | **地基直接供给，D7消费** | success、timeout、EOF、invalid envelope、id mismatch、remote reject逐类可见且调用完成 | U06 |
| **D07-R04** | daemon不在场时，队列/链SQLite终态仍经strict status读取，最终CLI/HTTP wire保持精确 | D7死态可观测；D1/D3接缝 | F01–F05，X07 | **地基直接供给，D7消费** | kill daemon后网关仍返回可parse status与队列终态；读取不改变SQLite文件 | U01–U04 |
| **D07-R05** | daemon不在场时，主events真实历史、最后事件、`daemon.stop`/`daemon.fatal`等死因线索和具名异常仍可读 | D7死态定义 | F11–F15，X07 | **地基直接供给，D7消费** | graceful stop与kill/fatal样本均显示可得历史、最后时间和现有死因线索 | U08–U10 |
| **D07-R06** | 首屏独立呈现R01–R03三证的原始分类和各自采样时间；任意分裂组合如实显示，不折成单一`running/alive` | D7性质1及分裂态验收 | F06–F09 | **D7自身建立** | pid活/socket死、connect成功/RPC失败、pid缺失而RPC成功等代表组合均不假活/假死 | U05、U06 |
| **D07-R07** | 死态首屏明确显示“daemon已死”、死于何时、死因线索、队列终态，并保持events/queue入口可达 | D7性质2 | F01–F05、F11–F15 | **D7自身建立** | stop/fatal/无明确死因三类均如实呈现；无证据时不编造原因 | U08–U10、U14 |
| **D07-R08** | daemon死与网络不可达是不同UI结果：网关仍应答即能呈现daemon死；网关/mesh不可达由浏览器连接层呈现，不能误标daemon状态 | D7性质3 | F01–F15提供daemon-down服务数据 | **D7自身建立** | 同一设备分别断daemon与断mesh；前者页面应答，后者无法到达gateway | U10、U14 |
| **D07-R09** | daemon死态提供一键start；start由gateway spawn `coder-loop daemon up`，不经过socket RPC | D7性质4 | F10 | **D7自身建立** | daemon无socket时点击start仍能拉起；没有伪RPC success | U15 |
| **D07-R10** | 活态stop与restart按既定机制触发；typed接受/拒绝/失败明确呈现，不把本地未完成冒充daemon拒绝 | D7性质4；D8接缝 | F07–F10 | **D7自身建立** | stop后进入死态；restart失败显示精确错误；操作不静默 | U07、U15 |
| **D07-R11** | gateway spawn出的daemon生命周期与gateway解耦；gateway退出/重启不带走daemon | D7性质4明确要求 | F10 | **D7自身建立** | start成功后终止gateway；daemon pid/socket/RPC仍可由新gateway观察 | U15 |
| **D07-R12** | 成功start/restart后的闭环以三证分别翻绿为完成观察；不以按钮返回、pid单证或单boolean代替 | D7性质4及一键恢复验收 | F06、F10 | **D7自身建立** | 浏览器与mesh手机分别操作；pid/process、connect、RPC三槽最终均成功 | U05、U06、U15 |
| **D07-R13** | 首屏同屏显示三证、每chain活run/最近转移、精确`rateLimit`冷却与最近具名异常；字段来自status/events typed边界，不在GUI重建 | D7性质5 | F04/F05、F09、F11–F15 | **D7自身建立** | 至少一活run及rate-limit/异常fixture；所有栏目在首屏可见，非法`rateLimit`shape被拒绝 | U04、U08–U10、U14 |

### B2. 计数与依赖判定

| 分类 | 需求 | 数量 | 判定 |
|---|---|---:|---|
| 地基直接供给 | D07-R01–R05 | **5** | 复用strict status、三证/typed transport与events；D7不复制probe、DB或event reader |
| D7自身建立 | D07-R06–R13 | **8** | 首屏组合、断网区别、start/stop/restart交互、spawn解耦与闭环观察 |
| 地基未闭合 | 无 | **0** | U项是运行证明未知；不构成合同或阶段gate |
| 原子需求总计 | D07-R01–R13 | **13** | 可进入后续需求拆分 |

### B3. 证据与 identity 边界

#### 三证

- pid/process、socket connect、RPC response是三个不同问题；各自保留failure和采样时间。
- RPC success必须绑定本次request identity并通过精确`daemon.status` codec。
- 三证无需原子采样；UI只能陈述各自采样时点，不能推导某个不可证的全局瞬间。
- `ps`扫描可作旁证，但不能替代pid文件/process槽，也不能因同pid去重掉RPC来源。

#### 死态事实

- queue/chain终态来自F01–F05的SQLite status，不因daemon死而切换到进程推断。
- events历史/最后事件/死因线索来自F11–F15；无明确fatal/stop证据时显示“未知”，不猜测。
- 活run、recent transition、rateLimit与异常分别消费已有status/RPC/events typed字段；D7不合成第二状态机。

#### 生命周期 identity

- start的完成不是spawn调用返回，而是spawn成功后独立daemon的三证最终翻绿。
- stop/restart的请求、响应与三证变化必须属于同一目标loop-data root；不得串到其他daemon实例。
- gateway lifecycle与daemon lifecycle解耦，不产生“gateway是daemon父监督器”的新职责。

### B4. 验证观察矩阵

| 场景 | 操作 | 必须观察 | 不能替代 |
|---|---|---|---|
| 活态 | daemon活、至少一active run，打开首屏 | 三证全绿；active run/recent transition/rateLimit/异常栏在场 | 单个`running:true` |
| 死态 | graceful stop与kill/fatal后刷新 | 网关仍应答；三证分槽；死时/死因线索/最后事件、events历史、queue终态可读 | CLI截图或mock page |
| 分裂态 | pid活/socket不可达；connect成功/RPC失败等 | 原始正负证据同时保留，无假活/假死 | 折叠health enum |
| 断网对照 | daemon死 vs mesh断开 | 前者gateway页面正常显示死态；后者浏览器无法到达gateway | 用daemon RPC失败代表断网 |
| start | 无daemon/socket时点击start | gateway spawn daemon up；进程脱离；三证最终翻绿 | 把start发送到不存在的socket |
| stop/restart | 活态依次执行 | typed结果/错误；stop后三证转死，restart后三证翻绿 | 按钮toast或pid单证 |
| spawn解耦 | gateway启动daemon后退出gateway | daemon继续运行；新gateway可重建三证 | 常驻通用supervisor |
| mesh闭环 | 手机经netbird重复死态start | 与本机相同结果，无应用层登录新增要求 | 本机curl |

### B5. 仍未证明但不构成地基缺口

| 未知 | 后续处理 | 不得生成的需求 |
|---|---|---|
| **U05** 跨用户pid/socket/`ps`权限errno与PID复用 | 补三证failure fixture并保留unknown分类 | 原子三证采样、强行证明pid身份 |
| **U06** client deadline与socket destroy真实行为 | silent/half-close集成测试 | server idle/handler deadline、connection cap |
| **U07** lifecycle RPC响应丢失/失败窗口 | stop/restart错误与三证最终状态对照 | durable operation、query/replay或known-outcome |
| **U08–U10** 真实events历史、writer交错、浏览器SSE/mesh行为 | 死态与异常专项E2E | schema framework、replay、Last-Event-ID |
| **U14** 首屏全部optional字段与浏览器路径 | 真实status/events fixture | GUI平行shape或静态替身 |
| **U15** spawn脱离、stop/restart与三证翻绿 | 本机+mesh真实生命周期E2E | 通用process supervisor |

### B6. 明确排除

1. 不建立通用process supervisor、守护策略、自动重启循环或daemon子进程托管平台。
2. 不增加server/response caps、server idle/handler deadline或connection cap。
3. 不重建operator认证、peer/token体系；沿既定gateway/operator与RPC机制。
4. 不要求pid/process、connect、RPC三证原子采样或合并为单一health事实。
5. 不用process/worktree/git反推queue、chain或active run状态。
6. 不把start改成socket RPC，不让gateway退出带走daemon。
7. 不要求events断线replay、restart cursor、跨流全序或统一三流历史。

## C. 证据索引

- 稳定语义：`AGG-544-gui-observability-gateway.md` D7；生命周期写面接缝见D8。
- 修补后地基：`expected-foundation-544.md` F01–F15、X02、X07、U01–U10、U14–U15。
- 纠偏摘要：`decision-S1-status-544.md`、`decision-S2-daemon-544.md` A。
