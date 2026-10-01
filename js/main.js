import { createTranslator, DEFAULTS, describeError, normalizeConfig } from "./core.js";
import { createChatHistory, hasEnglishText, isPlayerChat } from "./history.js";
import { createChatUI } from "./chat-ui.js";

const CONFIG_PATH = getGameDirectory() + "/Saved/SaveGames/Mods/DRGChatTranslator/config.json";
const STATUS_PATH = getGameDirectory() + "/Saved/SaveGames/Mods/DRGChatTranslator/status.json";
const HISTORY_PATH = getGameDirectory() + "/Saved/SaveGames/Mods/DRGChatTranslator/chat-history.json";
const INCOMING_PATH = "/Script/FSD.FSDGameState:ClientNewMessage";
let epoch = 0;
let disposed = false;
let inputRequest = 0;
let outgoingBusy = false;
let lastNoticeAt = 0;
let seen = new Map();
const handles = [];
const statusHistory = [];
let lastDiagnostics = null;
let uiLines = [];
let uiTimer = null;

function log(message) { print("[DRGChatTranslator] " + message); }
function valid(object) {
  try { return !!object && typeof object.IsValid === "function" && object.IsValid() && object.GetName().indexOf("Default__") !== 0; }
  catch (_) { return false; }
}
function field(object, name) {
  if (!object) return null;
  try { const value = GetProperty(object, name); if (value != null) return value; } catch (_) {}
  return object && object[name];
}
function unwrap(value) {
  return value && typeof value === "object" && value.ReturnValue !== undefined ? value.ReturnValue : value;
}
function text(value) {
  value = unwrap(value);
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value.ToString === "function") return String(value.ToString());
  if (value.Text != null) return text(value.Text);
  return typeof value === "number" ? String(value) : "";
}
function booleanCall(object, method) {
  try { return unwrap(CallFunction(object, method)) === true; } catch (_) { return false; }
}
function inputText(input) {
  try {
    const value = unwrap(CallFunction(input, "GetText"));
    if (typeof value === "string" || (value && typeof value === "object")) return text(value);
  } catch (_) {}
  return text(field(input, "Text"));
}
function allChats() {
  try {
    const find = typeof FindAllInstancesOfClass === "function" ? FindAllInstancesOfClass : FindAllOf;
    return (find("HUD_Chat_C") || []).filter(valid);
  } catch (_) { return []; }
}
function localCall(object, method, ...args) {
  if (typeof CallFunctionEx === "function") {
    const result = CallFunctionEx(object, method, ...args);
    if (result && result.__success === false) throw new Error("Local call failed");
    return result;
  }
  // Only invoke verified non-network HUD/input functions through this fallback.
  return CallFunction(object, method, ...args);
}
function releaseLine(line) {
  try { if (valid(line.widget)) localCall(line.widget, "RemoveFromParent"); } catch (_) {}
  try { if (valid(line.widget)) line.widget.RemoveFromRoot(); } catch (_) {}
}
function maintainLines() {
  uiTimer = null;
  const remaining = [];
  for (const line of uiLines) {
    if (disposed || line.epoch !== epoch || Date.now() >= line.until || !valid(line.panel) || !valid(line.chat) || !valid(line.widget)) {
      releaseLine(line); continue;
    }
    try {
      // The game's history refresh clears this panel. Reattach our own local lines.
      const parent = unwrap(CallFunction(line.widget, "GetParent"));
      const attached = valid(parent) && parent.GetName() === line.panel.GetName();
      if (!attached) localCall(line.panel, "AddChild", line.widget);
      localCall(line.chat, "Update Chat Background");
    } catch (_) {}
    remaining.push(line);
  }
  uiLines = remaining;
  if (uiLines.length) uiTimer = setTimeout(maintainLines, 500);
}
function display(message, sender = "翻译助手") {
  if (disposed) return;
  let shown = false;
  for (const chat of allChats()) {
    let widget = null;
    try {
      const panel = field(chat, "ChatMessages");
      if (!valid(panel)) continue;
      const cls = StaticFindObject("/Script/UMG.TextBlock");
      widget = NewUObject(cls, field(chat, "WidgetTree") || panel);
      if (!valid(widget)) throw new Error("No text widget");
      widget.AddToRoot();
      localCall(widget, "SetText", sender + "：" + message);
      localCall(widget, "SetAutoWrapText", true);
      localCall(widget, "SetVisibility", 3);
      // Use the game's font when it is available; otherwise retain the UMG font.
      const font = field(field(chat, "NewChatEdit"), "Font") || field(field(chat, "InputChatBox"), "Font");
      if (font) { try { localCall(widget, "SetFont", font); } catch (_) {} }
      localCall(panel, "AddChild", widget);
      uiLines.push({ chat, panel, widget, epoch, until: Date.now() + 45000 });
      shown = true;
    } catch (_) { if (widget) releaseLine({ widget }); log("本机文字显示失败，请查看配置工具的运行状态。"); }
  }
  // Bound retained local widgets even when many messages arrive.
  while (uiLines.length > 8) releaseLine(uiLines.shift());
  if (uiTimer) clearTimeout(uiTimer);
  if (uiLines.length) maintainLines();
  if (!shown) log("未找到可用的本机聊天界面。");
}
function recordStatus(message, diagnostics = null) {
  log(message);
  statusHistory.push({ time: new Date().toISOString(), message });
  while (statusHistory.length > 20) statusHistory.shift();
  if (diagnostics) lastDiagnostics = diagnostics;
  try {
    if (typeof writeFile === "function") writeFile(STATUS_PATH, JSON.stringify({ version: "0.2.1", history: statusHistory, diagnostics: lastDiagnostics }, null, 2));
  } catch (_) {}
}
function notify(message, throttle = false) {
  if (disposed) return;
  const now = Date.now();
  if (throttle && now - lastNoticeAt < 30000) return;
  lastNoticeAt = now;
  recordStatus(message);
  display(message);
}
function loadConfig() {
  const raw = readFile(CONFIG_PATH);
  return raw ? JSON.parse(raw.replace(/^\uFEFF/, "")) : DEFAULTS;
}
let initial;
try { initial = normalizeConfig(loadConfig()); } catch (_) { initial = DEFAULTS; log("配置无效，请打开本地配置工具重新保存。"); }
const translator = createTranslator({
  config: initial, fetch: (url, options) => fetch(url, options),
  AbortController: typeof AbortController === "function" ? AbortController : null,
});
const history = createChatHistory({
  path: HISTORY_PATH, readFile: path => readFile(path), writeFile: (path, value) => writeFile(path, value),
  scope: () => JSON.stringify([translator.getConfig().Endpoint, translator.getConfig().Model]),
  onError: message => recordStatus(message),
});
const translationTasks = new Map(), rowStates = new Map();
function localController() {
  for (const chat of allChats()) {
    try { const controller = unwrap(CallFunction(chat, "GetOwningPlayer")); if (valid(controller)) return controller; } catch (_) {}
  }
  return null;
}
function requestTranslation(source, target, force = false, priority = false) {
  const config = translator.getConfig();
  if (!config.Enabled) return Promise.reject({ userMessage: "翻译已关闭，请先打开翻译开关。" });
  const cached = history.cached(source, target);
  if (cached && !force) return Promise.resolve(cached);
  const key = JSON.stringify([config.Endpoint, config.Model, target, source.trim()]);
  if (translationTasks.has(key)) return translationTasks.get(key);
  const task = translator.translate(source, target, priority, force).then(result => {
    history.remember(source, target, result); return result;
  });
  translationTasks.set(key, task);
  const cleanup = () => { if (translationTasks.get(key) === task) translationTasks.delete(key); };
  task.then(cleanup, cleanup);
  return task;
}
function translateRow(id, force = false) {
  const row = history.get(id);
  if (!row || !hasEnglishText(row.source) || (rowStates.get(id) || {}).busy) return;
  rowStates.set(id, { busy: true, error: "" }); history.refresh();
  requestTranslation(row.source, "zh", force, true).then(() => {
    rowStates.set(id, { busy: false, error: "" }); history.refresh();
  }, error => {
    rowStates.set(id, { busy: false, error: describeError(error) }); history.refresh();
  });
  while (rowStates.size > 1000) rowStates.delete(rowStates.keys().next().value);
}
function setConfig(patch) {
  const next = normalizeConfig({ ...translator.getConfig(), ...patch });
  try {
    if (writeFile(CONFIG_PATH, JSON.stringify(next, null, 2)) === false) throw new Error("save failed");
    translator.configure(next);
    inputRequest++; outgoingBusy = false;
    chatUI.refresh();
    recordStatus("设置已保存：翻译" + (next.Enabled ? "开启" : "关闭") + "，自动英→中" + (next.IncomingEnabled ? "开启" : "关闭") + "。聊天记录继续收集。");
  } catch (_) { notify("翻译开关保存失败，请查看本地配置文件是否可写。"); }
}
const chatUI = createChatUI({
  valid, unwrap, field, call: localCall, notice: notify, log,
  history, rowState: id => rowStates.get(id) || {}, translateRow,
  getConfig: () => translator.getConfig(), setConfig, needsTranslation: hasEnglishText,
  controller: localController,
  find: name => (typeof FindAllInstancesOfClass === "function" ? FindAllInstancesOfClass(name) : FindAllOf(name)),
  font() { const chat = allChats()[0]; return chat ? field(field(chat, "NewChatEdit") || field(chat, "InputChatBox"), "Font") : null; },
  restoreTarget() {
    try {
      const find = typeof FindAllInstancesOfClass === "function" ? FindAllInstancesOfClass : FindAllOf;
      for (const hub of (find("ModHub_C") || []).filter(valid)) {
        const mounted = booleanCall(hub, "IsInViewport") || valid(unwrap(CallFunction(hub, "GetParent")));
        if (mounted && booleanCall(hub, "IsVisible")) return hub;
      }
      for (const chat of allChats()) {
        if (!unwrap(field(chat, "IsChatOpen"))) continue;
        const input = [field(chat, "InputChatBox"), field(chat, "NewChatEdit"), field(chat, "OutsiteChatbox")].find(valid);
        if (input) return input;
      }
      return null;
    } catch (_) { return null; }
  },
});

function knownPlayer(sender) {
  // System and host events use ES_Game; also reject fabricated senders if a roster is available.
  try {
    const find = typeof FindAllInstancesOfClass === "function" ? FindAllInstancesOfClass : FindAllOf;
    const names = (find("FSDPlayerState") || []).filter(valid).map(state => {
      try { return text(CallFunction(state, "GetPlayerName")); } catch (_) { return ""; }
    }).filter(Boolean);
    return !names.length || names.includes(sender);
  } catch (_) { return true; }
}

function incoming(_object, params) {
  if (disposed) return;
  const config = translator.getConfig();
  const entry = params && params[0];
  if (!isPlayerChat(entry)) return;
  const source = text(entry.Msg);
  const sender = text(entry.Sender);
  if (!source || !knownPlayer(sender)) return;
  const id = sender + "|" + source;
  const now = Date.now();
  if (now - (seen.get(id) || 0) < 1500) return;
  seen.set(id, now);
  if (seen.size > 100) seen.delete(seen.keys().next().value);
  const row = history.add(sender, source);
  if (!config.Enabled || !config.IncomingEnabled || !hasEnglishText(source)) return;
  if (!config.ApiKey && !history.cached(source, "zh")) return;
  const atEpoch = epoch;
  if (row) rowStates.set(row.id, { busy: true, error: "" }); history.refresh();
  requestTranslation(source, "zh").then(result => {
    if (row) rowStates.set(row.id, { busy: false, error: "" }); history.refresh();
    if (!disposed && epoch === atEpoch) display(result, "[中译] " + sender);
  }).catch(error => {
    if (row) rowStates.set(row.id, { busy: false, error: describeError(error) }); history.refresh();
    if (!disposed && epoch === atEpoch) notify(describeError(error), true);
  });
}

function findInput() {
  const diagnostics = [];
  let fallback = null;
  for (const chat of allChats()) {
    const open = !!unwrap(field(chat, "IsChatOpen"));
    const candidates = [field(chat, "InputChatBox"), field(chat, "NewChatEdit"), field(chat, "OutsiteChatbox")].filter(valid);
    for (const input of candidates) {
      try {
        const source = inputText(input);
        const focused = booleanCall(input, "HasKeyboardFocus") || booleanCall(input, "HasAnyUserFocus");
        const visible = booleanCall(input, "IsVisible");
        diagnostics.push({ name: input.GetName(), open, focused, visible, length: source.length });
        if (!source.trim()) continue;
        const candidate = { chat, input, source };
        if (focused) return candidate;
        if (!fallback && open && visible) fallback = candidate;
      } catch (_) {}
    }
  }
  if (!fallback) recordStatus("F8 输入框检查：未找到已输入文字的活动聊天框。", diagnostics);
  return fallback;
}
function translateInput() {
  if (disposed) return;
  if (outgoingBusy) return notify("正在翻译，请稍等。", true);
  const captured = findInput();
  if (!captured) return notify("请先打开聊天框，输入中文后按 F8。");
  const request = ++inputRequest;
  const atEpoch = epoch;
  outgoingBusy = true;
  notify("正在翻译输入框内容，请稍等，完成后再按回车发送。");
  requestTranslation(captured.source, "en", false, true).then(result => {
    if (disposed || request !== inputRequest || epoch !== atEpoch) return;
    if (!valid(captured.chat) || !valid(captured.input)) return;
    if (!unwrap(field(captured.chat, "IsChatOpen")) && !booleanCall(captured.input, "HasKeyboardFocus") && !booleanCall(captured.input, "HasAnyUserFocus")) return;
    const current = inputText(captured.input);
    if (current !== captured.source) return notify("输入内容已变化，保留当前文字；需要时再按 F8。");
    localCall(captured.input, "SetText", result);
    // Keep the original Chinese next to our own translated English without another API call.
    history.remember(result, "zh", captured.source);
    // No SendChatMessage, Server_NewMessage, synthetic Enter, or network game calls.
    notify("英文已放入输入框，检查后按回车发送。");
  }).catch(error => {
    if (!disposed && request === inputRequest && epoch === atEpoch) notify(describeError(error) + " 输入框原文保留。");
  }).then(() => { if (request === inputRequest) outgoingBusy = false; });
}
function resetScene() {
  epoch++;
  inputRequest++;
  outgoingBusy = false;
  seen.clear();
  translator.invalidate();
  chatUI.resetScene();
  if (uiTimer) clearTimeout(uiTimer);
  uiTimer = null;
  for (const line of uiLines) releaseLine(line);
  uiLines = [];
}
function reload() {
  resetScene();
  try {
    translator.configure(loadConfig());
    history.refresh(); chatUI.refresh();
    const config = translator.getConfig();
    notify(!config.Enabled ? "翻译已关闭。" : config.ApiKey ? "配置已加载，F7 测试，F8 翻译输入框。" : "尚未填写密钥。请打开本地配置工具保存，再按 F6。");
  } catch (_) { notify("配置读取失败，请打开本地配置工具重新保存。"); }
}
function selfTest() {
  notify("本机显示测试：这条中文应保留约 45 秒；正在测试翻译接口。");
  const atEpoch = epoch;
  translator.translate("Please don't call the drop pod yet.", "zh", true).then(result => {
    if (!disposed && epoch === atEpoch) { recordStatus("接口测试成功：" + result); display(result, "[接口测试]"); }
  }).catch(error => { if (!disposed && epoch === atEpoch) notify(describeError(error)); });
}

try {
  const ids = RegisterHook(INCOMING_PATH, null, incoming);
  if (Array.isArray(ids)) handles.push(ids);
  log("接收聊天监听已注册。");
} catch (_) { log("聊天监听注册失败；F8 输入框翻译仍可测试。请检查 UE4SS 是否启用。"); }
for (const binding of [["F6", reload], ["F7", selfTest], ["F8", translateInput], ["F9", () => chatUI.toggle()]]) {
  try { if (!RegisterKeyBind(binding[0], binding[1])) log(binding[0] + " 按键注册失败。"); }
  catch (_) { log(binding[0] + " 按键注册失败。"); }
}
if (typeof RegisterLoadMapPreHook === "function") {
  try { RegisterLoadMapPreHook(resetScene); } catch (_) {}
}
// Also detect new map/controller creation when optional LoadMap hooks are unavailable.
if (typeof NotifyOnNewObject === "function") {
  try { NotifyOnNewObject("FSDPlayerController", resetScene); } catch (_) {}
}
chatUI.startHub();
const startupConfig = translator.getConfig();
recordStatus("修复版 0.2.1 已加载：F6 加载配置，F7 测试，F8 中译英，F9 聊天记录。翻译" + (startupConfig.Enabled ? "开启" : "关闭") + "，自动英→中" + (startupConfig.IncomingEnabled ? "开启" : "关闭") + "。");
