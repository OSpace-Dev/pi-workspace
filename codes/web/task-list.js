import { api } from "./api.js";
import { $, notice, td } from "./ui.js";

const statusText = {
  starting: "启动中", idle: "可提问", answering: "回答中", stopping: "结束中",
  stopped: "已结束", resuming: "恢复中", failed: "运行失败", deleting: "删除中",
};

export function labelStatus(status) { return statusText[status] ?? status; }

export async function refreshTaskList() {
  const { items } = await api("/tasks");
  $("task-count").textContent = String(items.length);
  $("tasks-empty").hidden = items.length !== 0;
  const rows = $("task-rows");
  rows.replaceChildren();
  for (const item of items) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const link = document.createElement("a");
    link.href = `/tasks/${item.id}`;
    link.textContent = item.id.slice(0, 8);
    const small = document.createElement("small");
    small.textContent = item.connectionName;
    name.append(link, small);
    row.append(name, td(labelStatus(item.status)), td(new Date(item.createdAt).toLocaleString("zh-CN"), "muted"));
    const action = document.createElement("td");
    action.className = "actions";
    const open = document.createElement("a");
    open.href = link.href;
    open.textContent = "查看";
    action.append(open);
    row.append(action);
    rows.append(row);
  }
}

export function bindTaskList() {
  $("refresh-tasks").addEventListener("click", () => refreshTaskList().catch((error) => notice(error.message, true)));
  $("create-task-open").addEventListener("click", async () => {
    try {
      const { items } = await api("/connections");
      const select = $("task-connection");
      select.replaceChildren();
      for (const connection of items.filter((item) => item.enabled)) {
        const option = document.createElement("option");
        option.value = connection.id;
        option.textContent = `${connection.displayName} · ${connection.modelId}`;
        select.append(option);
      }
      if (!select.options.length) { notice("请先在模型管理中创建并启用连接。", true); return; }
      $("create-task-dialog").showModal();
    } catch (error) { notice(error.message, true); }
  });
  $("create-task-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    button.disabled = true;
    form.querySelector("[data-error]").textContent = "";
    try {
      const { task } = await api("/tasks", {
        method: "POST", body: JSON.stringify({ connectionId: $("task-connection").value }),
      });
      location.href = `/tasks/${task.id}`;
    } catch (error) { form.querySelector("[data-error]").textContent = error.message; }
    finally { button.disabled = false; }
  });
}
