# 独立 Pi Web 沙箱设计

- 编号：ARCH-20260927-011；日期：2026-09-27；状态：历史实现；新沙箱迁移见 [自主沙箱设计](2026-09-27-012-autonomous-sandbox-transition.md)
- 依据：[需求](../requirements/2026-09-27-002-pi-web-sandbox.md)、[运行任务设计](2026-09-27-009-pi-task-runtime.md)

## 证据与边界

本地 `pi-web-trial:pi-0.87.1` 镜像包含 Pi 0.87.1 和 MIT `@agegr/pi-web` 0.9.3；其 `pi-web --help` 提供 `PI_WEB_PASSWORD`、回环/host 选项。受限 UID、只读根、tmpfs 下已实际启动。Docker internal 网络不建立 published host port（探针 inspect Ports 为 `{}`），需要专用入口。

## 组件与数据

沿用模型代理的任务 grant/撤销/轮换，以及管理 API 的 TaskService 生命周期；迁移 007 给 workspace_tasks 增加 `kind=qa|sandbox`、`display_name`，旧行默认为 qa。QA 和沙箱分别列表/详情，旧 API 不混合。独立 SandboxRuntime 负责 Pi Web/入口容器、文件与只读令牌；TaskRuntime 继续只负责 QA。TaskService 根据 kind 分派运行路径；复用既有续期调度，沙箱使用同一 1h/提前10min/最多5min 窗口。

沙箱文件位于独立任务 UUID 目录：workspace、agent、token、owner、web-password。沙箱 owner 标明 kind；旧无 kind 的 owner 视为 qa。Pi Web 在 sandbox 容器中用 UID10001、只读根、无 capabilities、no-new-privileges、768MiB/1CPU/PID128；只挂载自身 workspace/agent 与只读 token，tmpfs `/tmp`。其 Docker 网络只连 internal task，允许访问认证模型代理，无普通公网出口。模型配置只指向 `proxy:3001/v1`，API key 为请求时读取的代理 token 文件。

每个 sandbox 另有无 secret 的 gateway 容器，在 external management 网络上绑定 127.0.0.1 的 Docker 动态端口，再连接 internal task 网络，只反向转发固定沙箱 Pi Web 的 HTTP/WebSocket/SSE；无通用代理目标输入。Pi Web 仍要求独立随机密码。gateway 和 Pi Web 均通过 task ID、固定镜像、标签和必要挂载校验归属后操作。管理 API 仅向已登录管理员返回 `http://127.0.0.1:<dynamic-port>` 与密码，响应 no-store。密码存任务目录及 Pi Web 环境，不能由沙箱外未认证 HTTP 访问；Docker 管理员可见，生产需换入口方案。

创建依次获取代理 grant、写 DB starting、准备文件、建/启 Pi Web 与 gateway、健康检查后 idle。故障撤销 grant 并停容器，DB failed 可重试删除。停止先撤销授权，再停 gateway 与 Web；恢复原容器，先获取新 grant、更新 token、启 Web/gateway并检查，失败补偿撤销与停机。删除先撤销、停并删除两容器、移除目录，最后删除数据库及代理任务；失败留 deleting 供重试。API 崩溃由现有 reconcile 收口 starting/resuming/stopping/deleting/failed。授权轮换更新文件并按摘要恢复中断状态。

## 验证与取舍

独立 gateway 带来每实例额外容器，但避免把 Pi Web 根路径、WebSocket/流式协议硬塞到管理 API，也保证内部 task 网络不发布主机端口。Docker 在停止/恢复同一 gateway 容器时可能重新分配动态端口，管理端每次从 inspect 读取最新地址；旧 URL 不可作为永久身份。此方案只在本地 loopback 使用，暂不引入多租户身份、TLS 入口或强沙箱。用独立 Compose 项目/镜像/卷验证，不重建旧预览。测试创建两个沙箱、密码、会话、授权、停止/恢复/删除、连接隔离和 desktop/mobile 管理流程。
