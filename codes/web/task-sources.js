import { api } from "./api.js";
import { $ } from "./ui.js";

let renderedSources = "";

export async function refreshSources(id, status) {
  const { items } = await api(`/tasks/${id}/sources`);
  $("source-count").textContent = `${items.length} / 10`;
  $("source-total").textContent = `${(items.reduce((sum, file) => sum + file.byteCount, 0) / 1024).toFixed(1)} / 300 KiB`;
  $("source-empty").hidden = items.length > 0;
  $("upload-form").hidden = !["idle", "stopped"].includes(status);
  const signature = JSON.stringify(items);
  if (signature === renderedSources) return;
  renderedSources = signature;
  $("source-list").replaceChildren(...items.map((file) => {
    const row = document.createElement("li");
    const link = document.createElement("a");
    link.href = `/tasks/${id}/sources/${file.id}`;
    link.textContent = file.name;
    const size = document.createElement("small");
    size.textContent = `${(file.byteCount / 1024).toFixed(1)} KiB`;
    row.append(link, size);
    return row;
  }));
}

export function bindSources(id, refresh) {
  $("upload-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("upload-sources");
    if (button.disabled) return;
    button.disabled = true;
    $("upload-error").textContent = "";
    try {
      const selected = [...$("source-files").files];
      if (!selected.length) throw new Error("请选择资料。");
      if (selected.length > 10) throw new Error("每个任务最多 10 个文件。");
      if (selected.some((file) => file.size > 100 * 1024)) throw new Error("单文件不能超过 100 KiB。");
      if (selected.reduce((sum, file) => sum + file.size, 0) > 300 * 1024) throw new Error("资料总量不能超过 300 KiB。");
      const files = await Promise.all(selected.map(async (file) => {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { name: file.name, base64: btoa(binary) };
      }));
      await api(`/tasks/${id}/sources`, { method: "POST", body: JSON.stringify({ files }) });
      $("source-files").value = "";
      await refresh();
    } catch (error) { $("upload-error").textContent = error.message; }
    finally { button.disabled = false; }
  });
}
