import { bindSession } from "./session.js";
import { api } from "./api.js";
import { $, notice } from "./ui.js";

const match = /^\/tasks\/([0-9a-f-]{36})\/sources\/([0-9a-f-]{36})$/i.exec(location.pathname);
bindSession(async () => {
  try {
    if (!match) throw new Error("原文地址无效。");
    const [, taskId, sourceId] = match;
    $("back-task").href = `/tasks/${taskId}`;
    const { source } = await api(`/tasks/${taskId}/sources/${sourceId}`);
    $("source-title").textContent = source.name;
    $("source-meta").textContent = `${source.byteCount} 字节 · ${new Date(source.createdAt).toLocaleString("zh-CN")}`;
    const params = new URLSearchParams(location.search);
    const start = Number(params.get("start"));
    const end = Number(params.get("end"));
    const original = $("source-original");
    original.textContent = source.text;
    if (params.has("start") && params.has("end") && Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end > start && end <= source.text.length) {
      const mark = document.createElement("mark");
      mark.textContent = source.text.slice(start, end);
      original.replaceChildren(document.createTextNode(source.text.slice(0, start)), mark, document.createTextNode(source.text.slice(end)));
      mark.scrollIntoView({ block: "center" });
    }
    notice("");
  } catch (error) { notice(error.message, true); }
});
