import { errorMessage } from "./api.js";

const phases = { preparing: "准备资料", model: "模型回答中", validating: "校验出处", completed: "完成", failed: "失败" };

export function renderTurn(turn, taskId) {
  const article = document.createElement("article");
  article.className = "turn";
  const question = document.createElement("p");
  question.className = "turn-question";
  question.textContent = turn.question;
  article.append(question);
  if (turn.status === "pending") {
    const progress = document.createElement("p");
    progress.className = "turn-progress";
    progress.setAttribute("role", "status");
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(turn.createdAt ?? Date.now()).getTime()) / 1000));
    progress.dataset.createdAt = turn.createdAt ?? new Date().toISOString();
    progress.dataset.phase = phases[turn.phase] ?? "回答中";
    progress.textContent = `${progress.dataset.phase} · ${seconds} 秒`;
    article.append(progress);
  } else if (turn.status === "failed") {
    const failure = document.createElement("p");
    failure.className = "turn-error";
    failure.textContent = errorMessage(turn.errorCode ?? "ANSWER_FAILED");
    article.append(failure);
  } else if (turn.result) {
    const state = document.createElement("p");
    state.className = `answer-result ${turn.result.status}`;
    state.textContent = { answered: "资料回答", no_basis: "资料无依据", conflict: "资料存在冲突" }[turn.result.status];
    article.append(state);
    for (const claim of turn.result.claims) {
      const text = document.createElement("p");
      text.className = "turn-answer";
      text.textContent = claim.text;
      const references = document.createElement("ul");
      references.className = "citations";
      for (const citation of claim.citations) {
        const row = document.createElement("li");
        const link = document.createElement("a");
        link.href = `/tasks/${taskId}/sources/${citation.sourceId}?start=${citation.start}&end=${citation.end}`;
        link.textContent = `${citation.fileName} · ${citation.location}`;
        const matched = document.createElement("span");
        matched.textContent = "引文匹配";
        row.append(link, matched);
        references.append(row);
      }
      article.append(text, references);
    }
  } else {
    const answer = document.createElement("p");
    answer.className = "turn-answer";
    answer.textContent = turn.answer;
    article.append(answer);
  }
  return article;
}
