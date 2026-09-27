let csrf = "";
let unauthorized = () => {};

const errorText = {
  PI_WEB_NOT_READY: "Pi Web 暂未就绪。",
  DOCUMENT_INVALID_INPUT: "资料上传内容无效。", DOCUMENT_INVALID_NAME: "文件名无效，请去掉路径或控制字符。",
  DOCUMENT_UNSUPPORTED: "仅支持 TXT 和 Markdown 文件。", DOCUMENT_INVALID_ENCODING: "文件必须是 UTF-8 文本，且不含空字符。",
  DOCUMENT_EMPTY: "不能上传空白资料。", DOCUMENT_FILE_TOO_LARGE: "单文件不能超过 100 KiB。",
  DOCUMENT_TOTAL_TOO_LARGE: "资料总量不能超过 300 KiB。", DOCUMENT_TOO_MANY: "每个任务最多 10 个文件。",
  DOCUMENT_DUPLICATE_NAME: "已存在同名资料，请修改文件名。", SOURCE_NOT_FOUND: "资料不存在或已删除。",
  DOCUMENT_CONTEXT_TOO_LARGE: "本轮资料编码超出传输预算，请新建任务并减少资料。",
  ANSWER_FORMAT_INVALID: "模型回答格式无效，本轮未形成可核验结果。",
  CITATION_INVALID: "模型引用不存在、不匹配或无法唯一定位，本轮未通过出处校验。",
  INVALID_INPUT: "请检查输入内容。", INVALID_ALLOWLIST: "请输入不带路径的 HTTPS origin。",
  INVALID_TARGET: "Base URL 必须是有效的 HTTPS 地址。", TARGET_NOT_ALLOWED: "请先批准该 origin。",
  DNS_UNAVAILABLE: "DNS 查询失败，请稍后重试。", NON_PUBLIC_ADDRESS: "目标解析到非公网地址，已拒绝。",
  STALE_OR_UNAVAILABLE: "连接状态已变化，请刷新后重试。", UNAUTHORIZED: "认证已失效，请重新登录。",
  INVALID_CSRF: "安全校验失败，请重新登录。", RATE_LIMITED: "尝试过于频繁，请稍后重试。",
  MANAGEMENT_UNAVAILABLE: "管理服务暂不可用。",
  TASK_SERVICE_UNAVAILABLE: "任务服务暂不可用。", TASK_RUNTIME_ERROR: "任务环境暂不可用。",
  TASK_START_FAILED: "任务启动失败，可在列表中检查或删除。", TASK_STOP_FAILED: "停止未完成，请重试。",
  TASK_RESUME_FAILED: "恢复失败，请检查任务状态。", TASK_DELETE_FAILED: "删除未完成，请重试。",
  TASK_NOT_FOUND: "任务不存在或已删除。", TASK_NOT_IDLE: "任务当前不可提问。",
  TASK_NOT_STOPPED: "请先结束任务。", TASK_SESSION_MISSING: "原会话或容器缺失，无法恢复。",
  TASK_BUSY: "任务操作正在进行，请稍后刷新。", CONNECTION_UNAVAILABLE: "模型连接不可用。",
  ANSWER_FAILED: "本轮回答失败，请检查连接后重试。",
  ANSWER_INTERRUPTED: "本轮回答已被结束操作中断。",
  INTERRUPTED_START: "启动被中断，请结束后恢复任务。", INTERRUPTED_ANSWER: "本轮回答被中断，请结束后恢复任务。",
  TASK_CONTAINER_STOPPED: "Pi 环境意外停止，请结束后恢复任务。",
  TASK_TOKEN_UNAVAILABLE: "任务授权已失效，请结束后恢复任务。",
  TOKEN_RENEWAL_RETRY: "授权续期暂未完成，将自动重试。",
};

export function setCsrf(value) { csrf = value; }
export function onUnauthorized(callback) { unauthorized = callback; }
export function errorMessage(code) { return errorText[code] || "操作失败，请稍后重试。"; }

export async function api(path, options = {}) {
  const response = await fetch(`/api/v1${path}`, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...(options.method ? { "X-CSRF-Token": csrf } : {}), ...options.headers },
  });
  const data = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== "/login") unauthorized();
    throw new Error(errorMessage(data.error?.code));
  }
  return data;
}
