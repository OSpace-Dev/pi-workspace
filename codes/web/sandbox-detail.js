import { api, errorMessage } from "./api.js";
import { $, notice } from "./ui.js";
import { sandboxStatus } from "./sandbox-list.js";

let refreshing = false;
let access = null;
export async function refreshSandboxDetail(id) {
  if (refreshing) return;
  refreshing = true;
  try {
    const { task, ready, webUrl, containerState, observedAt, errorCode } = await api(`/sandboxes/${id}`);
    $("sandbox-title").textContent = task.displayName;
    $("sandbox-meta").textContent = `${task.mode === "autonomous" ? "Pi Web · 独立配置" : "旧版 · " + task.connectionName} · ${task.id.slice(0, 8)}`;
    $("sandbox-state").textContent = sandboxStatus(task.status) +
      (task.status === "idle" && !ready ? " · Pi Web 尚未就绪" : "") +
      (task.errorCode ? ` · ${errorMessage(task.errorCode)}` : "");
    $("sandbox-url").textContent = webUrl ?? "—";
    $("open-sandbox").disabled = task.status !== "idle" || !ready;
    $("stop-sandbox").hidden = !["idle", "failed", "stopping"].includes(task.status);
    $("resume-sandbox").hidden = task.status !== "stopped";
    $("delete-sandbox-open").textContent = task.status === "deleting" ? "重试删除" : "删除";
    $("sandbox-id").textContent = task.id;
    $("sandbox-created").textContent = new Date(task.createdAt).toLocaleString("zh-CN");
    $("sandbox-connection").textContent = task.mode === "autonomous" ? "沙箱内独立配置" : task.connectionName;
    const states = { running: "运行", exited: "已退出", created: "已创建", missing: "缺失", unknown: "未知", restarting: "重启中", dead: "异常" };
    $("probe-container").textContent = states[containerState] ?? (task.mode === "autonomous" ? "未知" : "旧版未采集");
    $("probe-web").textContent = containerState === "unknown" ? "未知" : ready ? "就绪" : "未就绪";
    $("probe-time").textContent = observedAt ? new Date(observedAt).toLocaleString("zh-CN") : "—";
    $("probe-error").textContent = errorCode ? errorMessage(errorCode) : "";
    if (task.status !== "idle" || !ready || access?.url !== webUrl) {
      access = null;
      $("sandbox-password").value = "";
      $("sandbox-password").type = "password";
      $("reveal-password").textContent = "显示";
    }
  } finally { refreshing = false; }
}

export function bindSandboxDetail(id) {
  const timer = setInterval(() => {
    if (!$("workspace").hidden && !document.hidden) refreshSandboxDetail(id).catch((error) => notice(error.message, true));
  }, 4000);
  window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
  async function getAccess() {
    if (!access) access = await api(`/sandboxes/${id}/access`);
    return access;
  }
  $("open-sandbox").addEventListener("click", async () => {
    const popup = window.open("", "_blank");
    try { const { url } = await getAccess(); if (popup) popup.location.href = url; else notice("浏览器拦截了新窗口。", true); }
    catch (error) { popup?.close(); notice(error.message, true); }
  });
  $("reveal-password").addEventListener("click", async () => {
    try {
      const input = $("sandbox-password");
      if (input.type === "text") { input.type = "password"; $("reveal-password").textContent = "显示"; return; }
      input.value = (await getAccess()).password;
      input.type = "text"; $("reveal-password").textContent = "隐藏";
    } catch (error) { notice(error.message, true); }
  });
  $("copy-password").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText((await getAccess()).password); notice("密码已复制。"); }
    catch (error) { notice(error.message, true); }
  });
  $("stop-sandbox").addEventListener("click", async () => {
    $("stop-sandbox").disabled = true;
    try { await api(`/sandboxes/${id}/stop`, { method: "POST" }); access = null; await refreshSandboxDetail(id); notice("沙箱已停止。"); }
    catch (error) { notice(error.message, true); }
    finally { $("stop-sandbox").disabled = false; }
  });
  $("resume-sandbox").addEventListener("click", async () => {
    $("resume-sandbox").disabled = true;
    try { await api(`/sandboxes/${id}/resume`, { method: "POST" }); await refreshSandboxDetail(id); notice("沙箱已恢复。"); }
    catch (error) { notice(error.message, true); }
    finally { $("resume-sandbox").disabled = false; }
  });
  $("delete-sandbox-open").addEventListener("click", () => $("delete-sandbox-dialog").showModal());
  $("delete-sandbox-confirm").addEventListener("click", async () => {
    $("delete-sandbox-confirm").disabled = true;
    $("delete-sandbox-error").textContent = "";
    try { await api(`/sandboxes/${id}`, { method: "DELETE" }); location.href = "/sandboxes"; }
    catch (error) { $("delete-sandbox-error").textContent = error.message; }
    finally { $("delete-sandbox-confirm").disabled = false; }
  });
}
