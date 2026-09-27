# 自主沙箱转向设计

- 编号：ARCH-20260927-012；日期：2026-09-27；状态：本地实现并经合成验收；[SBX-005](../questions/2026-09-27-005-autonomous-sandbox-egress.md) 已选择可信本地直接出站
- 依据：[新需求](../requirements/2026-09-27-003-autonomous-agent-sandbox.md)、[历史设计](2026-09-27-011-pi-web-sandbox.md)

## 现状与迁移边界

当前 `workspace_tasks` 的主键外键指向 `model_proxy_tasks`，`model_connection_id` 非空；`TaskService.create` 先取控制域连接和 grant；`TaskFiles.prepare` 把代理 URL、模型 ID 和令牌写入沙箱 Pi 配置；沙箱连 Docker internal 网络。因此旧沙箱无法自主选择模型，直接删前端连接选择也无法工作。

新建自主沙箱使用独立持久化实体与服务职责：沙箱记录只存 ID、名称、生命周期、错误、创建/更新时间，不复用代理任务外键和 grant。历史 `kind=sandbox` 行保留为旧类型，可停止、查看、删除；迁移不得重写其 Pi 配置或凭据。新 API 创建请求仅含名称，响应包含独立沙箱 ID 和状态。旧模型代理和 QA 任务服务保持其原有边界，管理导航可继续访问但不参与新沙箱启动。

运行代理创建沙箱专属 `workspace`、Pi agent 目录和访问密码，不生成代理 `models.json`、`settings.json` 或 token 挂载。Pi Web 自行管理设置；运行代理只负责容器/目录生命周期及只读观察。按 SBX-005，每沙箱使用独立的非 internal Docker bridge，Web 容器仅连该网络，gateway 连接该网络和管理网络，只转发该实例 Pi Web 的 HTTP、WebSocket 和 SSE。入口维持本机回环动态端口及密码。容器不挂 Docker socket，保持非 root、只读根、cap drop、CPU/内存/PID 限制。沙箱与控制服务只通过运行代理交互。

探针首轮从 Docker inspect 与 Pi Web 健康响应收集 `containerState`、`webReady`、`observedAt` 和错误；采集失败显示 unknown，页面不得推断模型调用内容或读取 Pi 凭据。后续 Agent 活动可由沙箱内明确的事件适配器提供，经脱敏、大小限制和身份校验后再接入；不直接解析私有 Pi 日志当成稳定契约。

## 生命周期与兼容

创建：写 starting 记录、准备独立目录、创建 Web/gateway、健康检查，再转 running；失败停容器并留可诊断记录。停止：先停 gateway、再停 Web，状态转 stopped；恢复原目录和容器，健康检查成功才转 running；删除先校验归属并停/删容器，再清理专属目录和记录。服务崩溃后根据记录和 Docker 标签对账；不能误认其他项目容器。新旧类型用明确版本标签区分。动态 Web 端口在恢复后可能改变，页面每次重新查询。

数据库采用新增 `agent_sandboxes` 表和迁移 008，避免放松旧代理任务的非空和外键约束。新服务、路由、UI 模块独立于 QA/模型连接模块；对外契约更新 OpenAPI。旧 `kind=sandbox` 数据通过原 TaskService 路由兼容，页面明确标为旧版。部署顺序为迁移、服务与运行代理、页面、隔离验收。回退保留旧数据和卷；旧应用不理解新表，因此回退前须停止新容器并保留其目录，不能声称旧版本可操作新沙箱。

## 验证重点

无控制平面连接创建；Pi Web 内配置后直连合成端点；第二沙箱不能读取第一个的文件或配置；停止恢复保留设置和会话；异常退出探针显示故障；删除只影响目标；验收 Compose 容器和网络在结束后清理、数据库卷与任务目录按台账处理。真实供应商费用和语义不由合成端点证明。
