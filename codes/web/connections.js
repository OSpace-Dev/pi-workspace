import { api } from "./api.js";
import { $, notice, submit, td } from "./ui.js";

let selected = null;

export async function refreshConnections() {
  const { items } = await api("/connections");
  $("connection-count").textContent = String(items.length);
  $("connections-empty").hidden = items.length !== 0;
  const body = $("connection-rows");
  body.replaceChildren();
  for (const item of items) {
    const row = document.createElement("tr");
    const name = document.createElement("td");
    const strong = document.createElement("strong");
    strong.textContent = item.displayName;
    const small = document.createElement("small");
    small.textContent = item.modelId;
    name.append(strong, small);
    row.append(name, td(item.baseUrl, "muted"));
    const state = document.createElement("span");
    state.className = `status${item.enabled ? "" : " disabled"}`;
    state.textContent = item.enabled ? "已启用" : "已停用";
    const stateCell = document.createElement("td");
    stateCell.append(state);
    row.append(stateCell, td(new Date(item.updatedAt).toLocaleString("zh-CN"), "muted"));
    const actions = document.createElement("td");
    actions.className = "actions";
    if (item.enabled) {
      for (const [label, action] of [["更换凭据", "credential"], ["停用", "disable"]]) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "quiet";
        button.textContent = label;
        button.addEventListener("click", () => openAction(action, item));
        actions.append(button);
      }
    }
    row.append(actions);
    body.append(row);
  }
}

function openAction(action, item) {
  selected = item;
  $(action === "disable" ? "disable-target" : "credential-target").textContent = item.displayName;
  $(action === "disable" ? "disable-dialog" : "credential-dialog").showModal();
}

export function bindConnections() {
  $("create-open").addEventListener("click", () => $("create-dialog").showModal());
  $("refresh-connections").addEventListener("click", async () => {
    try { await refreshConnections(); notice(""); } catch (error) { notice(error.message, true); }
  });
  for (const dialog of [$("create-dialog"), $("credential-dialog")]) {
    dialog.addEventListener("close", () => {
      const form = dialog.querySelector("form");
      form.reset();
      form.querySelector("[data-error]").textContent = "";
    });
  }
  $("create-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, () => api("/connections", {
      method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form))),
    }), $("create-dialog"), refreshConnections);
  });
  $("credential-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    submit(form, () => api(`/connections/${selected.id}/credential`, {
      method: "PATCH", body: JSON.stringify({ version: selected.version, credential: $("new-credential").value }),
    }), $("credential-dialog"), refreshConnections);
  });
  $("disable-confirm").addEventListener("click", async () => {
    $("disable-confirm").disabled = true;
    try {
      await api(`/connections/${selected.id}/disable`, {
        method: "PATCH", body: JSON.stringify({ version: selected.version }),
      });
      $("disable-dialog").close();
      await refreshConnections();
      notice("连接已停用。");
    } catch (error) { notice(error.message, true); }
    finally { $("disable-confirm").disabled = false; }
  });
}
