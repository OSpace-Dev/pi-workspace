import { bindSession } from "./session.js";
import { bindTaskList, refreshTaskList } from "./task-list.js";
import { bindTaskDetail, refreshTaskDetail } from "./task-detail.js";
import { $, notice } from "./ui.js";

const id = /^\/tasks\/([0-9a-f-]{36})$/i.exec(location.pathname)?.[1] ?? null;
$("task-list-view").hidden = id !== null;
$("task-detail-view").hidden = id === null;
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $(button.dataset.close).close());
});
bindTaskList();
if (id) bindTaskDetail(id);
bindSession(async () => {
  try {
    if (id) await refreshTaskDetail(id);
    else await refreshTaskList();
    notice("");
  } catch (error) { notice(error.message, true); }
});
