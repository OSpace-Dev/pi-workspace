import { api } from "./api.js";
import { $, notice, td } from "./ui.js";

const statusText = { starting: "启动中", idle: "运行中", stopping: "停止中", stopped: "已停止",
  resuming: "恢复中", failed: "运行失败", deleting: "删除中" };
export function sandboxStatus(status) { return statusText[status] ?? status; }

export async function refreshSandboxList() {
  const { items } = await api("/sandboxes");
  $("sandbox-count").textContent = String(items.length);
  $("sandboxes-empty").hidden = items.length !== 0;
  const rows = $("sandbox-rows");
  rows.replaceChildren(...items.map((item) => {
    const row = document.createElement("tr");
    const title = document.createElement("td");
    const link = document.createElement("a");
    link.href = `/sandboxes/${item.id}`;
    link.textContent = item.displayName;
    const connection = document.createElement("small");
    connection.textContent = item.mode === "autonomous" ? "Pi Web · 独立配置" : `旧版 · ${item.connectionName}`;
    title.append(link, connection);
    row.append(title, td(sandboxStatus(item.status)), td(new Date(item.createdAt).toLocaleString("zh-CN"), "muted"));
    const action = document.createElement("td");
    action.className = "actions";
    const open = document.createElement("a");
    open.href = link.href; open.textContent = "查看";
    action.append(open); row.append(action);
    return row;
  }));
}

export function bindSandboxList() {
  $("refresh-sandboxes").addEventListener("click", () => refreshSandboxList().catch((error) => notice(error.message, true)));
  $("create-sandbox-open").addEventListener("click", async () => {
    try {
      $("create-sandbox-dialog").showModal();
      $("sandbox-name").focus();
    } catch (error) { notice(error.message, true); }
  });
  $("create-sandbox-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    if (button.disabled) return;
    button.disabled = true;
    form.querySelector("[data-error]").textContent = "";
    try {
      const { task } = await api("/sandboxes", { method: "POST", body: JSON.stringify({
        name: $("sandbox-name").value.trim(),
      }) });
      location.href = `/sandboxes/${task.id}`;
    } catch (error) { form.querySelector("[data-error]").textContent = error.message; }
    finally { button.disabled = false; }
  });
}
