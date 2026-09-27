# 沙箱管理契约

- 编号：API-20260927-005；日期：2026-09-27；状态：可实施
- 消费者：本机管理浏览器；机器契约：[sandbox-management.yaml](../../codes/openapi/sandbox-management.yaml)
- 关联：[设计](../architecture/2026-09-27-011-pi-web-sandbox.md)

沿用管理 Cookie、Host/Origin、写操作 CSRF。GET/POST `/api/v1/sandboxes` 列表/创建（`{name,connectionId}`）；GET `/api/v1/sandboxes/:id` 返回元数据与实际容器 ready/webUrl；GET `/api/v1/sandboxes/:id/access` 返回 `{url,password}`，仅管理员、no-store；POST stop/resume 与 DELETE 同路径分别返回状态/204。密码不出现在普通列表或详情响应。所有 UUID 校验；QA ID 在沙箱路由返回 404，反之亦然。

错误使用既有 `{error:{code}}`，无 Docker、模型供应商或密码信息。创建非幂等；重复提交由页面禁用，丢失响应的持久幂等属于 Backlog 8。stop/delete 可重试，resume 仅 stopped。状态和端口来源于 runtime inspect，不信任浏览器传值；动态端口由 Docker 分配且只绑定回环。
