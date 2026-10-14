# Agent Note: 配对闸门的服务查找与宿主门禁

Status: implemented

## Problem

任何非 loopback 域名都会打断全部受闸门保护的路由：技能中心、Git 图谱与用量面板都返回**空 body 的 `400`**，技能中心面板显示 "加载失败：HTTP 400"（浏览器端把不是它错误信封的 body 映射为 `HTTP <status>`）。而这些部署里的域名是合法的——它声明在宿主的 `trustedHosts`（`--trusted-host`）中，宿主自己的 `/api` 对同一浏览器工作正常。

这一状态由两个彼此独立的缺陷造成。其一，只要 `ctx.get` 没取到服务，`isPairedOrLoopbackAllowed` 就回退去读 `ctx.remoteWebUiPairing` 这个属性。真实 cordis context 一定提供 `ctx.get`，且对从未 inject 的属性直接抛 "cannot get property ... without inject"；该异常从路由 handler 的 `guard()` 逃出（在 handler 自己的 `try`/`catch` 之前），而 `dsh-host-webserver` 会把未处理的路由拒绝转成 `res.writeHead(400); res.end()`。于是设计中的拒绝从未到达客户端，故障看起来像请求本身不合法。上游把它记为 #1814（更早的 #1780 因表单问题关闭）；两者均已关闭，且没有任何分支带有修复。

其二，即便去掉这个抛异常，闸门也只认 loopback 与 remote-web-ui 的已配对设备 cookie。因此已在配置中显式信任的非 loopback 域名会在每条家族路由上收到 `403 forbidden: loopback-only`，而宿主 `/api` 门禁对同一请求是放行的——何况本 SDK cohort 里没有任何已发布包提供 `remoteWebUiPairing`，配对放行路径在此根本无法行使。

## Decision

`shared/host/pair-access.ts` 把直接属性读取收窄到不提供 `ctx.get` 的 context（裸规格测试替身）：生产 context 只通过 `ctx.get('remoteWebUiPairing', false)` 解析该服务，它返回 `undefined` 而不抛异常。

此后闸门回退到宿主自己的门禁：按请求 `ctx.get('connection')`，调用 `connection.requestRejection(request)`。返回 `undefined` 表示宿主会放行这一请求——它的 Host/Origin 围栏通过且浏览器已登录；返回 `403`（不可信域名）与 `401`（浏览器未登录）仍保持拒绝。这与 `dsh-market` 一致：它同样按请求读取该服务，因为 `HostConnectionService` 在异步初始化之后才构造。插件不声明对该服务的依赖：服务缺失时闸门仍仅限 loopback。

拒绝语义不变：loopback 放行、有效的已配对 cookie 放行、无 `ctx.get` 的测试 context 保留属性回退，其余一律拒绝。`dsh-git-graph`、`dsh-skill-explorer`、`dsh-usage` 中的生成副本来自 `node scripts/sync-shared.mjs`；漂移门禁（`pnpm sync-shared:check`）保证三份同步。

## Testing

- `shared/tests/pair-access.spec.ts` 承载权威用例：原有五条，加上一个对未声明属性读取会抛异常的 context 代理（闸门必须不抛且拒绝）、放行的门禁、返回 `403` 的门禁、返回 `401` 的门禁，以及没有门禁方法的 connection 服务。共享套件共 10 条（合计 98 条）；消费方套件：`dsh-skill-explorer` 176、`dsh-git-graph` 183、`dsh-usage` 173。
- `node scripts/sync-shared.mjs --check` 报告全部消费副本同步；共享包可独立通过 typecheck（`tsc --noEmit`）。

## Alternatives considered

- 用 `try`/`catch` 包住属性读取：能在同一个表达式里保住测试替身回退，但真实 context 会在每条受保护路由的每个非 loopback 请求上抛出并吞掉一个 Error。把读取收窄到不提供 `ctx.get` 的 context 得到同一行为，且生产路径上不产生异常。
- 在插件内用配置的可信域名校验 `Host` 头：等于在三个包里复制宿主的信任表，并且接受任何能连到监听端口者伪造的 `Host`（本部署监听 `0.0.0.0`）。`connection.requestRejection` 还额外要求该域名下浏览器的会话 cookie。
- 用本机反向代理为受保护路径改写 `Host` 与 `Origin`：无需改插件，但要多跑并守护一个组件，把 loopback 边界换成"谁能连到代理"，且其余仅限 loopback 的家族路由依旧不可用。
- 等上游修： #1814 与 #1780 均已关闭，`main` 与 `dev` 都没有闸门相关改动，面板在可信非 loopback 域名下始终不可用。

## Consequences

- 经 `trustedHosts` 声明的域名访问时，技能中心、Git 图谱与用量路由现在对已登录浏览器开放，无需配对、无需代理。接受的风险恰是宿主门禁的风险：域名由配置信任，浏览器必须持有该域名的会话 cookie。
- 暴露在局域网的 `dsh web` 若没有这枚 cookie，仍然收到 `401`/`403`；不可信域名仍是 `403`。
- 闸门判定仍是唯一共享源加生成副本，并由漂移门禁守住；没有任何消费包改动调用点或自家门禁。
