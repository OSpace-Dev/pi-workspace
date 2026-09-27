# 固定 IP HTTPS 传输评审

- 编号：REV-20260927-004
- 日期：2026-09-27
- 状态：复审通过
- 评审人：Codex
- 对应任务：[TASK-20260927-004](../planning/2026-09-27-005-fixed-ip-https-transport.md)
- 依据：[代理边界决策](../decisions/2026-09-27-002-model-proxy-boundary.md)、[传输设计](../architecture/2026-09-27-003-fixed-ip-https-transport.md)

## 发现

1. **REV-20260927-004-F001 / P2 / `codes/src/model-proxy/https-transport.ts` 的 socket 建立路径**：Agent lookup 只返回策略 IP，但没有检查 TCP socket 的实际 `remoteAddress`。边界决策要求检查实际连接地址；若运行时连接路径改变，当前代码无法拒绝不匹配目标。修复方向：连接建立后按地址族和规范化 IP 比较，失配时立即销毁请求，错误不回显地址。
2. **REV-20260927-004-F002 / P2 / `codes/src/model-proxy/https-transport.test.ts` 的流故障测试**：已覆盖首响应、空闲超时和取消，未覆盖响应头与片段已到之后 socket 突然关闭的情况。该路径必须让消费方收到稳定的流失败，而不能以完整流结束。修复方向：增加 TLS 夹具断流用例并检查错误类别。

## 结论与边界

初评结论：阻断正式验收，回到同一任务实施并复审。当时 6 项测试和类型检查在独立 WSL Docker 容器中通过；测试 CA、服务与数据均为本地夹具。

2026-09-27 复审：F001 已解决，`https-transport.ts` 在 TLS 连接建立后对远端 IP 和地址族进行规范化比较，失配即销毁请求；F002 已解决，新断流用例在收到首段 SSE 后强制关闭上游 socket，并确认消费方获得 `STREAM_FAILURE`。7 项传输测试、5 项策略回归及类型检查通过。未发现剩余阻断性问题，结论：通过。尚未检查真实供应商、产品代理、任务授权或公网 DNS 行为，这些不属于本任务。
