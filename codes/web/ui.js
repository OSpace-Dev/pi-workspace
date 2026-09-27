export const $ = (id) => document.getElementById(id);

export function notice(message, isError = false) {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", isError);
}

export function td(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}

export async function submit(form, action, dialog, refresh) {
  const button = form.querySelector('button[type="submit"]');
  const errorNode = form.querySelector("[data-error]");
  button.disabled = true;
  errorNode.textContent = "";
  try {
    await action();
    form.reset();
    dialog.close();
    await refresh();
    notice("已保存。");
  } catch (error) { errorNode.textContent = error.message; }
  finally { button.disabled = false; }
}
