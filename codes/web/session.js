import { api, onUnauthorized, setCsrf } from "./api.js";
import { $ } from "./ui.js";

function showLogin() {
  $("workspace").hidden = true;
  $("logout").hidden = true;
  $("login-view").hidden = false;
  setCsrf("");
}

export function bindSession(refresh) {
  const showWorkspace = () => {
    $("login-view").hidden = true;
    $("workspace").hidden = false;
    $("logout").hidden = false;
    refresh();
  };
  onUnauthorized(showLogin);
  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    $("login-error").textContent = "";
    try {
      const data = await api("/login", { method: "POST", body: JSON.stringify({ key: $("admin-key").value }) });
      setCsrf(data.csrfToken);
      $("admin-key").value = "";
      showWorkspace();
    } catch (error) { $("login-error").textContent = error.message; }
  });
  $("logout").addEventListener("click", async () => {
    try { await api("/logout", { method: "POST" }); }
    catch (error) { $("login-error").textContent = error.message; }
    finally { showLogin(); }
  });
  api("/session").then((data) => {
    if (data.authenticated) { setCsrf(data.csrfToken); showWorkspace(); }
    else showLogin();
  }).catch(showLogin);
}
