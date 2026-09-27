import { bindSession } from "./session.js";
import { bindSandboxList, refreshSandboxList } from "./sandbox-list.js";
import { bindSandboxDetail, refreshSandboxDetail } from "./sandbox-detail.js";
import { $, notice } from "./ui.js";

const id = /^\/sandboxes\/([0-9a-f-]{36})$/i.exec(location.pathname)?.[1] ?? null;
$("sandbox-list-view").hidden = id !== null;
$("sandbox-detail-view").hidden = id === null;
document.querySelectorAll("[data-close]").forEach((button) =>
  button.addEventListener("click", () => $(button.dataset.close).close()));
bindSandboxList();
if (id) bindSandboxDetail(id);
bindSession(async () => {
  try {
    if (id) await refreshSandboxDetail(id);
    else await refreshSandboxList();
    notice("");
  } catch (error) { notice(error.message, true); }
});
