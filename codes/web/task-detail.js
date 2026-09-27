import { api, errorMessage } from "./api.js";
import { $, notice } from "./ui.js";
import { labelStatus } from "./task-list.js";
import { renderTurn } from "./task-answer.js";
import { bindSources, refreshSources } from "./task-sources.js";

let refreshing = false;
let renderedTurns = "";

export async function refreshTaskDetail(id) {
  if (refreshing) return;
  refreshing = true;
  try {
  const { task, turns } = await api(`/tasks/${id}`);
  $("task-title").textContent = `任务 ${task.id.slice(0, 8)}`;
  $("task-meta").textContent = `${task.connectionName} · 创建于 ${new Date(task.createdAt).toLocaleString("zh-CN")}`;
  $("task-state").textContent = labelStatus(task.status) + (task.errorCode ? ` · ${errorMessage(task.errorCode)}` : "");
  $("stop-task").hidden = !["idle", "answering", "failed", "stopping"].includes(task.status);
  $("resume-task").hidden = task.status !== "stopped";
  $("prompt-form").hidden = task.status !== "idle";
  $("delete-task-open").textContent = task.status === "deleting" ? "重试删除" : "删除";
  $("turns-empty").hidden = turns.length !== 0;
  const signature = JSON.stringify(turns);
  if (signature !== renderedTurns) {
    $("turns").replaceChildren(...turns.map((turn) => renderTurn(turn, id)));
    renderedTurns = signature;
  } else {
    for (const progress of $("turns").querySelectorAll("[data-created-at]")) {
      const seconds = Math.max(0, Math.floor((Date.now() - new Date(progress.dataset.createdAt).getTime()) / 1000));
      progress.textContent = `${progress.dataset.phase} · ${seconds} 秒`;
    }
  }
  await refreshSources(id, task.status);
  } finally { refreshing = false; }
}

export function bindTaskDetail(id) {
  bindSources(id, () => refreshTaskDetail(id));
  const timer = setInterval(() => {
    if (!$("workspace").hidden && !document.hidden) refreshTaskDetail(id).catch((error) => notice(error.message, true));
  }, 2000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  $("prompt-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("send-prompt");
    if (button.disabled) return;
    const input = $("prompt-input");
    const message = input.value.trim();
    if (!message) return;
    button.disabled = true;
    $("prompt-error").textContent = "";
    $("task-state").textContent = "回答中";
    $("turns-empty").hidden = true;
    $("turns").append(renderTurn({ question: message, status: "pending", phase: "preparing" }, id));
    renderedTurns = "";
    try {
      await api(`/tasks/${id}/prompt`, { method: "POST", body: JSON.stringify({ message }) });
      input.value = "";
      await refreshTaskDetail(id);
    } catch (error) {
      $("prompt-error").textContent = error.message;
      await refreshTaskDetail(id).catch(() => undefined);
    } finally { button.disabled = false; }
  });
  $("stop-task").addEventListener("click", async () => {
    $("stop-task").disabled = true;
    try { await api(`/tasks/${id}/stop`, { method: "POST" }); await refreshTaskDetail(id); notice("任务已结束。"); }
    catch (error) { notice(error.message, true); await refreshTaskDetail(id).catch(() => undefined); }
    finally { $("stop-task").disabled = false; }
  });
  $("resume-task").addEventListener("click", async () => {
    $("resume-task").disabled = true;
    try { await api(`/tasks/${id}/resume`, { method: "POST" }); await refreshTaskDetail(id); notice("任务已恢复。"); }
    catch (error) { notice(error.message, true); await refreshTaskDetail(id).catch(() => undefined); }
    finally { $("resume-task").disabled = false; }
  });
  $("delete-task-open").addEventListener("click", () => $("delete-task-dialog").showModal());
  $("delete-task-confirm").addEventListener("click", async () => {
    $("delete-task-confirm").disabled = true;
    $("delete-error").textContent = "";
    try { await api(`/tasks/${id}`, { method: "DELETE" }); location.href = "/tasks"; }
    catch (error) { $("delete-error").textContent = error.message; await refreshTaskDetail(id).catch(() => undefined); }
    finally { $("delete-task-confirm").disabled = false; }
  });
}
