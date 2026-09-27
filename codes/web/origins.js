import { api } from "./api.js";
import { $, notice, td } from "./ui.js";

export async function refreshOrigins() {
  const { items } = await api("/origins");
  $("origin-count").textContent = String(items.length);
  $("origins-empty").hidden = items.length !== 0;
  const body = $("origin-rows");
  body.replaceChildren();
  for (const item of items) {
    const row = document.createElement("tr");
    row.append(td(item.origin), td(new Date(item.createdAt).toLocaleString("zh-CN"), "muted"));
    body.append(row);
  }
}

export function bindOrigins() {
  $("origin-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      await api("/origins", { method: "POST", body: JSON.stringify({ origin: $("origin-input").value }) });
      $("origin-input").value = "";
      await refreshOrigins();
      notice("目标已批准。");
    } catch (error) { notice(error.message, true); }
    finally { button.disabled = false; }
  });
}
