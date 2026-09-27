# WSL Docker 资源台账

- 日期：2026-09-27；状态：已执行本轮清理；责任人：Codex
- 范围：本项目 `piws-*` 容器、网络、卷及任务目录；未触碰其他项目

## 本轮盘点与动作

以下为自主沙箱升级前的清理快照；当前状态见文末“自主沙箱迭代收口”。

清理前 Docker 总计 40 个容器、38 个运行。按 Compose 标签确认并移除了 `piws-control-dev`、`piws-admin-preview`、`piws-product-preview`、`piws-task-preview`、`piws-task-acceptance`、`piws-document-preview`、`piws-document-acceptance`、`piws-sandbox-acceptance` 的 28 个 Compose 容器及各自网络；移除了合成验收沙箱的 Web 与 gateway 两个容器。所有这些项目的命名数据库卷和 WSL 任务目录保留，以免未经核实删除数据；当前没有运行开销，但仍占磁盘，之后核对内容再决定删除。

当前唯一长期运行的本项目入口是 `piws-sandbox-preview`：API `127.0.0.1:30207`、proxy、runtime、DB 共四个容器；其数据卷 `piws-sandbox-preview_task_db` 和专属任务目录保留。预览沙箱 `a5b9fe84-2edf-43c6-90d4-0dc5f845ece5` 的 Web/gateway 容器已停止，管理 API 状态为 `stopped`，可在页面恢复。历史资料问答容器 `piws-task-3bbcd45f-5f76-42dd-a3b8-9a21908fe61f` 已退出但保留供检查；所属控制面和网络已退役，不能直接从原页面恢复。

清理后 Docker 总计 10 个容器、6 个运行，其中本项目运行 4 个；另有 `pi-web-trial` 和 `nginx_proxy` 运行、`cuda-env` 退出，均未操作。37 个卷仍存在，未执行卷、镜像、build cache 的全局 prune。`30200`～`30206` 和 `30208` 的旧页面已退役；`30207` 是当前可操作的旧架构预览，完成新沙箱切换后再退役。

## 后续阶段规则

- 每次测试开始登记项目名、端口、动态容器标签、数据库卷和任务目录；使用独立 Compose 项目，不重建用户已有环境。
- 合成验收结束即停并移除其容器和网络；需展示时明确限定保留时间，结束时再次核对。只保留一个当前可操作预览。
- 用户沙箱通过管理 API 停止或删除，让数据库状态与容器一致。临时验收的容器可清除，但任何命名卷和任务目录须先核对内容及恢复价值，不运行 `docker system prune` 或 `docker volume prune`。
- 阶段收口记录 `docker ps -a`、Compose 项目标签与实际运行数；不对未知归属容器执行操作。

## 自主沙箱迭代收口（2026-09-27）

隔离验收项目 `piws-autonomous-acceptance` 使用 `30208`、四个 Compose 容器、三条 Compose 网络、一个命名数据库卷、专属 WSL 任务目录，以及测试期间的动态沙箱和合成上游容器。检查完成时 `agent_sandboxes` 为零，动态容器和网络均已删除；随后执行 Compose down，核对卷的项目标签后移除专属卷、三个镜像标签，并用 `rmdir` 清除仅含空 `autonomous` 目录的任务树。未运行全局 prune。

`piws-sandbox-preview` 已在原数据卷上升级迁移 008，仍为唯一产品预览（API `30207`、proxy、runtime、DB 四个基础容器）。新式展示沙箱 `b5bfe62a-da17-4d8f-87d0-883dfc358152` 的 Pi Web 与 gateway 两个容器运行，各有独立网络与目录；旧沙箱 `a5b9fe84-2edf-43c6-90d4-0dc5f845ece5` 恢复验证后再次停止，其两容器退出但保留原会话。`pi-web-trial`、`nginx_proxy` 和其他项目资源未操作。新式展示沙箱可由管理页停止释放两个运行容器，后续可恢复。

最终只读核对：Docker 共 12 个容器、8 个运行；其中本项目 6 个运行（上述四个基础容器和两个新式沙箱容器），旧沙箱两容器及旧资料问答容器均退出。`piws-autonomous-acceptance` 容器和网络不存在，`30208` 拒绝连接；`30207/health` 返回 `management-api` 的 `ok`，数据库中展示沙箱状态为 `idle`。其他项目容器未操作。
