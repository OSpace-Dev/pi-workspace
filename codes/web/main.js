import { bindConnections, refreshConnections } from "./connections.js";
import { bindOrigins, refreshOrigins } from "./origins.js";
import { bindSession } from "./session.js";
import { $, notice } from "./ui.js";

const view = location.pathname === "/models/origins" ? "origins" : "connections";
document.title = `${view === "origins" ? "批准目标" : "模型连接"} | Agent Workspace`;
$("connections-view").hidden = view !== "connections";
$("origins-view").hidden = view !== "origins";
$("create-open").hidden = view !== "connections";
document.querySelector("h1").textContent = view === "origins" ? "批准目标" : "模型连接";
document.querySelectorAll(".tab").forEach((tab) => {
  tab.classList.toggle("active", tab.dataset.view === view);
  if (tab.dataset.view === view) tab.setAttribute("aria-current", "page");
});
document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => $(button.dataset.close).close());
});
bindConnections();
bindOrigins();
bindSession(async () => {
  try {
    await (view === "origins" ? refreshOrigins() : refreshConnections());
    notice("");
  } catch (error) { notice(error.message, true); }
});
