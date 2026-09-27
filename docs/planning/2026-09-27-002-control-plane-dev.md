# 控制平面容器化开发入口

- 编号：TASK-20260927-001
- 日期：2026-09-27
- 状态：完成；实现、只读评审与本地环境验收通过
- 执行负责人：Codex
- 依据：[本地拓扑决策](../decisions/2026-09-27-001-local-control-plane-topology.md)、[Backlog 条目 2](2026-09-26-001-initial-backlog.md)

## 目标与范围

在 WSL Docker 中用一条 Compose 命令启动 TypeScript/Node 控制 API 和 PostgreSQL，Windows 本机可检查 API 存活及数据库就绪，编辑 `codes/` 的 API 源码可触发开发容器更新。WSL 主机不安装 Node、npm 包或 PostgreSQL。此任务是开发入口，不构成文档问答产品闭环。

- 包含：`codes/` 内的 API、Dockerfile、Compose、一次性本地数据库密码初始化脚本、健康接口、开发与停止说明；PostgreSQL 数据卷。
- 不包含：Web 页面、业务数据表、模型代理、运行代理、Docker socket 挂载、Pi 任务容器、真实模型密钥、公开业务 API。
- 假设：首次只使用合成资料，API 仅发布到本机回环地址；健康接口不含用户数据。实现失败时可停止并移除本任务新建容器，保留数据卷以便诊断；不清理现有 Pi Web 试用环境。

## 最小契约与完成定义

| 操作 | 成功 | 失败 |
| --- | --- | --- |
| `GET /health` | 200，固定 `status: ok` 与服务名；只表示进程存活 | 进程不可达 |
| `GET /ready` | 数据库 `SELECT 1` 成功时 200，固定 `status: ready` | 查询失败时 503，固定 `status: unavailable`，不返回连接信息或密码 |

1. 按 `codes/README.md` 的命令可初始化本地随机数据库密码、启动并停止 API 与 PostgreSQL；数据库仅在 Docker 内部网络，API 只绑定回环地址。
2. `GET /health` 与 `GET /ready` 达到上述结果；数据库停止时 `/ready` 返回 503，恢复后返回 200。
3. 修改 API 源文件后，开发容器不重建即可反映变化；记录 Windows 源码挂载的实测行为。
4. TypeScript 类型检查通过；源码和文档不含真实凭据或本机绝对路径；现有试用容器不受影响。

## 验证

在 WSL Docker 运行本任务提供的启动、日志、停止命令；从 Windows 请求两个健康接口；临时修改源文件验证热更新并恢复；停止/恢复数据库验证 readiness；核对容器端口、挂载和 WSL 主机进程。若某一步无法完成，保留失败证据和未完成状态，不把任务标记为完成。

评审：[REV-20260927-001](../reviews/2026-09-27-001-control-plane-dev.md)通过；验收：TEST-20260927-001通过。开发环境保持运行供本机查看，后续任务按 Backlog 排序推进。
