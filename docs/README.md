# 项目文档导航

## 当前推进入口

- **当前可操作入口：**`http://127.0.0.1:30207/sandboxes` 已升级为[自主配置的独立 Agent 沙箱](requirements/2026-09-27-003-autonomous-agent-sandbox.md)，可只填名称创建、打开专属 Pi Web、停止、恢复和删除；页面显示基础容器探针。当前有一个新式运行沙箱供直接体验，模型需在其 Pi Web 中自行配置。[任务](planning/2026-09-27-015-autonomous-sandbox.md)、[复审](reviews/2026-09-27-014-autonomous-sandbox.md)、验收、[资源台账](operations/2026-09-27-001-local-docker-ledger.md)。
- 旧控制域模型代理/资料问答结果仍是历史验收，不再是新沙箱创建前提。旧沙箱保持停止并可恢复。旧文档中的 `30200`～`30206`、`30208` 是历史展示地址，当前不可访问；真实供应商目标连通性尚未验证。

- [旧版独立 Pi Web 沙箱](planning/2026-09-27-014-pi-web-sandbox.md)：历史代理依赖增量；[设计](architecture/2026-09-27-011-pi-web-sandbox.md)、[契约](api/2026-09-27-005-pi-web-sandbox.md)、[复核](reviews/2026-09-27-013-pi-web-sandbox.md)与受控验收保留作历史证据。`30208` 旧合成演示已退役。

- [多资料问答闭环](planning/2026-09-27-013-document-qa.md)：TXT/Markdown 上传、不可变原文、轮次快照、结构化回答、引文匹配、独立原文高亮路由及停止恢复删除已完成。见[设计](architecture/2026-09-27-010-document-qa.md)、[UI](ui/2026-09-27-003-document-qa.md)、[契约](api/2026-09-27-004-document-qa.md)、[复审](reviews/2026-09-27-012-document-qa.md)和受控验收。当时的产品预览 `30205/tasks` 和合成演示 `30206/tasks` 均已退役；真实供应商语义/上下文验证及任务连接切换仍是历史功能的后续候选。

- [2026-09-27 首轮启动与 Pi 接口核查](planning/2026-09-27-001-kickoff.md)：任务、证据、进展及下一步。
- [已确认的文档问答需求](requirements/2026-09-27-001-document-qa-local-slice.md)：DQA-003～005 已回答，涵盖验收样例、输入规模与首轮访问范围。
- [沙箱生命周期决策](questions/2026-09-26-003-sandbox-isolation.md)：SBX-003～004 已回复，用户结束后停止、管理平面手动删除。
- [最小架构草案](architecture/2026-09-27-001-local-workspace.md)：组件边界、任务状态和剩余验证。
- [模型接入决策](questions/2026-09-27-001-model-access.md)：MOD-001～002 已回复，采用可配置 OpenAI 兼容 API、数据库持久化及控制域模型代理。
- [控制平面拓扑决策](decisions/2026-09-27-001-local-control-plane-topology.md)：CP-001～002 已回复，确认本地服务与 Engine 访问边界。
- [首个开发入口任务](planning/2026-09-27-002-control-plane-dev.md)：API 与 PostgreSQL 的 Docker 开发已完成；见验收结果。
- [模型代理最小设计](architecture/2026-09-27-002-model-proxy.md)和[HTTP 契约草案](api/2026-09-27-001-model-proxy.md)：Pi 0.87.1 流式协议、安全边界及验证方法。
- [模型代理边界决策](decisions/2026-09-27-002-model-proxy-boundary.md)：MPX-001～002 已回复，确认 HTTPS origin 清单与任务令牌生命周期。
- 模型协议验收：固定测试上游的 Pi 0.87.1 RPC 正常流、上游错误和断流均已验证。
- [出站目标策略任务](planning/2026-09-27-004-upstream-target-policy.md)：已完成，见验收结果。
- [固定 IP HTTPS 传输设计](architecture/2026-09-27-003-fixed-ip-https-transport.md)与[任务](planning/2026-09-27-005-fixed-ip-https-transport.md)：内部流式连接已完成，见验收结果；产品代理仍待设计。
- [模型连接持久化设计](architecture/2026-09-27-004-model-connection-store.md)：[MPX-003](decisions/2026-09-27-003-model-credential-key.md)已确认本地主密钥恢复边界；[任务](planning/2026-09-27-006-model-connection-store.md)与隔离验收已完成。
- [管理写入与任务令牌设计](architecture/2026-09-27-005-model-management-and-task-tokens.md)及[本地管理接口](api/2026-09-27-002-model-management.md)：[MPX-004～006](decisions/2026-09-27-004-model-management-and-token-renewal.md)和[MPX-007](decisions/2026-09-27-005-task-token-window.md)已确认；本地管理接口已实现，产品代理仍未 Ready。
- [Pi 请求时令牌重读探针](planning/2026-09-27-007-pi-token-refresh-probe.md)：同一 Pi 进程已在隔离 WSL Docker 中使用更新后的合成令牌，见验收；不等于产品授权实现。
- [内部任务令牌授权存储](planning/2026-09-27-008-task-token-store.md)：迁移、摘要存储、一次轮换交叠与撤销已通过隔离验收，尚未接入任务生命周期。
- [任务令牌时间窗口](planning/2026-09-27-009-task-token-window.md)：1 小时到期、提前 10 分钟轮换时点与最多 5 分钟交叠已在内部存储强制，见隔离验收；自动调度仍未实现。
- [可操作的模型连接工作台](planning/2026-09-27-010-model-management-console.md)：已在独立 WSL Docker 项目运行本地管理页面，见隔离验收；产品模型代理与 Pi 任务仍待集成。
- [受控 Pi 产品流式调用](planning/2026-09-27-011-product-model-proxy.md)：已完成授权状态、停止撤销、活动流取消和模块拆分，见[设计](architecture/2026-09-27-008-product-model-proxy.md)、[契约](../codes/openapi/model-proxy.yaml)、[复审](reviews/2026-09-27-010-product-model-proxy.md)及验收。该轮管理预览曾位于 `30202/models/connections`，现已退役。
- [可操作 Pi 任务闭环](planning/2026-09-27-012-pi-task-runtime.md)：运行代理、只读令牌目录、自动续期、原会话停止/恢复和任务列表/详情已完成；见[设计](architecture/2026-09-27-009-pi-task-runtime.md)、[页面规格](ui/2026-09-27-002-task-console.md)、[API](api/2026-09-27-003-task-runtime.md)、[复审](reviews/2026-09-27-011-pi-task-runtime.md)与验收。当时的产品预览 `30203/tasks` 和合成演示 `30204/tasks` 均已退役；后续资料上传和原文回看已在多资料问答增量实现。

本目录是 Agent Workspace 开发过程文档的唯一归档位置。稳定规则见 [AGENTS.md](../AGENTS.md)。模型代理、任务运行与多资料问答是已实现的历史增量；当前目标改为自主配置的独立沙箱。首版方向见 [首个可用场景与范围](questions/2026-09-26-001-first-usable-scope.md)，交付顺序与最新状态见 [Product Backlog](planning/2026-09-26-001-initial-backlog.md)。

`docs/testing/` 的验收记录与截图仅在本地保留，不纳入 Git；仓库内保留可重复运行的测试代码与各任务的验收结论。

| 文档位置 | 唯一归属 | 创建时机 |
| --- | --- | --- |
| `requirements/` | 已确认的目标、范围、验收条件 | 需求澄清完成时 |
| `questions/` | 待确认问题及回答记录 | 存在阻塞决策时 |
| `planning/` | Product Backlog、迭代目标、里程碑与任务状态 | 首轮交付规划时 |
| `architecture/` | 架构、数据与关键技术设计 | 需求需要设计时 |
| `api/` | 跨边界接口和事件契约 | 出现接口时 |
| `ui/` | 用户流程与界面规格 | 出现用户界面设计时 |
| `decisions/` | 已确认且需长期保留的产品、技术或流程决策 | 决策作出时 |
| `reviews/` | 只读代码评审与复审结论 | 实现完成后 |
| `testing/` | 本地测试方案、结果与验收证据，不纳入 Git | 正式测试时 |
| `deployments/` | 发布、验证与回退记录 | 发布时 |
| `operations/` | 已部署版本的维护与故障记录 | 进入运维时 |

按实际需要创建目录和文件。一个主题只保留一份权威记录，其他文档通过相对链接引用；未确认的内容不得放入“已确认需求”或“已作决策”的位置。小型低风险任务可在 `planning/` 的任务记录中保留所需的简短需求、验证和结论。

新文档应写明日期、状态、关联任务或决策、证据、结论及下一步；文件名遵循 [AGENTS.md](../AGENTS.md) 的日期或类别编号规则。持续更新原记录，保留必要的变更原因和验收结果。

需要用户回答的问题统一写在 `questions/` 对应主题文档的回答区，由用户直接编辑回复；对话只通知文档位置和受影响工作。具体执行规则见 [AGENTS.md 的异步问题与决策](../AGENTS.md#异步问题与决策)。
