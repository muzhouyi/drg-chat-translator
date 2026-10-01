import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createTranslator, describeError } from "../js/core.js";
import { createChatHistory, isPlayerChat } from "../js/history.js";

const config = { ApiKey: "test-key-local-only" };
const ok = content => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const turn = () => new Promise(resolve => setTimeout(resolve, 5));

test("without a key, no chat content is submitted", async () => {
  let calls = 0;
  const translator = createTranslator({ fetch: () => { calls++; } });
  await assert.rejects(translator.translate("hello", "zh"), /密钥/);
  assert.equal(calls, 0);
});

test("one request at a time; repeated translation uses memory cache", async () => {
  let calls = 0, active = 0, peak = 0;
  const translator = createTranslator({ config, fetch: async (_url, options) => {
    calls++; active++; peak = Math.max(peak, active);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "glm-4-flash-250414");
    assert.equal(body.messages.length, 2);
    assert.equal(body.stream, false);
    await turn(); active--;
    return ok("译文 " + body.messages[1].content);
  } });
  assert.deepEqual(await Promise.all([translator.translate("hello", "zh"), translator.translate("ready?", "zh")]), ["译文 hello", "译文 ready?"]);
  await translator.translate("hello", "zh");
  assert.equal(calls, 2);
  assert.equal(peak, 1);
});

test("scene invalidation rejects queued and active requests and ignores late responses", async () => {
  let complete;
  const translator = createTranslator({ config, fetch: () => new Promise(resolve => { complete = resolve; }) });
  const first = translator.translate("hello", "zh");
  const second = translator.translate("ready?", "zh");
  const outcomes = Promise.allSettled([first, second]);
  await turn();
  translator.invalidate();
  const result = await outcomes;
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "rejected");
  complete(ok("late translation"));
  await turn();
});

test("timeouts release the queue even if fetch never resolves", async () => {
  let calls = 0;
  const translator = createTranslator({ config, timers: {
    setTimeout: callback => setTimeout(callback, 10), clearTimeout,
  }, fetch: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(ok("成功")) });
  const stalled = translator.translate("hello", "zh");
  const next = translator.translate("ready?", "zh");
  await assert.rejects(stalled, /超时/);
  assert.equal(await next, "成功");
});

test("provider errors never surface response body or credentials", async () => {
  const translator = createTranslator({ config, fetch: async () => ({ ok: false, status: 401, body: "Authorization: test-key-local-only" }) });
  try { await translator.translate("hello", "zh"); assert.fail("should reject"); }
  catch (error) {
    assert.match(describeError(error), /密钥无效/);
    assert.doesNotMatch(describeError(error), /test-key/);
  }
});

test("overlong translated output fails instead of silently truncating it", async () => {
  const translator = createTranslator({ config, fetch: async () => ok("x".repeat(501)) });
  await assert.rejects(translator.translate("hello", "zh"), /译文过长/);
});

async function runtimeFixture(options = {}) {
  const events = new Map(), keys = new Map(), calls = [], requests = [], logs = [], files = new Map(), widgets = [], uiCallbacks = [], bindings = new Map(), lookups = [], hubCallbacks = [], notifications = new Map();
  let chatScans = 0, hubScans = 0, pageCreates = 0, onGameThread = false;
  let fixtureConfig = { ...config, ...(options.config || {}) };
  let bindingSequence = 0;
  let hub = null;
  const owner = { IsValid: () => true, GetName: () => "GameInstance_0" };
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const input = { value: "先别叫空降舱", IsValid: () => true, GetName: () => "NewChatEdit" };
  const panel = { IsValid: () => true, GetName: () => "ChatMessages" };
  const state = { IsValid: () => true, GetName: () => "PlayerState", name: "Me" };
  const controller = { IsValid: () => true, GetName: () => "LocalPC", PlayerState: state };
  const chat = { IsValid: () => true, GetName: () => "HUD_Chat_C_0", IsChatOpen: options.open !== false, ChatMessages: panel,
    [options.inputName || "NewChatEdit"]: input };
  const result = value => options.wrapped ? { ReturnValue: value, __success: true } : value;
  const newObject = type => {
    const index = widgets.length;
    const widget = { type, children: [], IsValid: () => true, GetName: () => type + "_" + index,
      IsA: name => name === type, AddToRoot: () => {}, RemoveFromRoot: () => { widget.released = true; } };
    widgets.push(widget); return widget;
  };
  const commonCall = (object, method, ...args) => {
    calls.push({ object, method, args, onGameThread });
    if (['GetAsset', 'BeginDeferredActorSpawnFromClass', 'FinishSpawningActor', 'Create', 'RegisterMod', 'AddModToUI'].includes(method) && !onGameThread) {
      throw new Error('native operation on non-game thread');
    }
    if (method === 'GetAsset' && options.dispatchFailure) throw new Error('native loading failed');
    if (method === 'DoesImplementInterface') return result(!options.interfaceRejected);
    if (method === 'GetAsset') {
      if (options.adapterUnavailable) return result(null);
      return result({ type: args[0].AssetName, IsValid: () => true, GetName: () => args[0].AssetName });
    }
    if (method === 'Create') {
      if (options.firstPageCreateFails && ++pageCreates === 1) throw new Error('native page temporarily unavailable');
      return result(newObject(args[1].type));
    }
    if (method === 'BeginDeferredActorSpawnFromClass') { const actor = newObject(args[1].type); actor.isActor = true; return result(actor); }
    if (method === 'FinishSpawningActor') return result(args[0]);
    if (method === 'GetModInfo') return { ModName: 'Chat Translator · 聊天翻译', ModAuthor: 'Local Chat Translator', ModVersion: '0.2.2', __success: true };
    if (method === 'GetModPages') return { HubPages: object.TranslatorPages || [], __success: true };
    if (method === 'AddModToUI' || method === 'RegisterMod') {
      const host = method === 'RegisterMod' ? object : object.ModBP, mod = args[0], menu = host.Widget_ModHub.MenuItemList;
      assert.equal(mod.isActor, true, 'native MenuItem.UserMod requires an Actor');
      if (method === 'RegisterMod' && host.RegisteredMods.includes(mod)) return { __success: true };
      if (method === 'RegisterMod') host.RegisteredMods.push(mod);
      if (!menu.MenuItems.some(item => item.UserMod === mod)) {
        const item = newObject('MenuItem_C'); item.UserMod = mod; item.value = 'Chat Translator · 聊天翻译'; menu.MenuItems.push(item);
        const id = ++bindingSequence;
        const label = newObject('TextBlock'); label.value = 'Chat Translator · 聊天翻译'; item.children.push(label);
        bindings.set(id, { object: item, callback: () => {
          const page = mod.TranslatorPages[0]; commonCall(hub.PageContainer, 'ClearChildren'); commonCall(hub.PageContainer, 'AddChild', page);
        } });
      }
      commonCall(menu, 'SortItems'); return { __success: true };
    }
    if (method === 'SortItems') {
      commonCall(object.ItemsScrollBox, 'ClearChildren');
      for (const item of object.MenuItems) if (item.value.charCodeAt(0) <= 256) commonCall(object.ItemsScrollBox, 'AddChild', item);
      return { __success: true };
    }
    if (method === "GetText") { if (options.getTextFails) throw new Error("getter missing"); return result(object.value); }
    if (method === "SetText") { object.value = args[0]; return { __success: true }; }
    if (method === "HasKeyboardFocus" || method === "HasAnyUserFocus") return result(options.focused !== false);
    if (method === "IsVisible") return result(object === hub ? options.hubVisible !== false : object.visibility !== 1);
    if (method === "IsInViewport") return result(object === hub ? !options.embeddedHub : !!object.inViewport);
    if (method === "GetOwningPlayer") return controller;
    if (method === "GetPlayerName") return object.name;
    if (method === "GetParent") return result(object.parent || null);
    if (method === "AddChild" || method === "AddChildToCanvas") {
      args[0].parent = object; object.children ||= []; object.children.push(args[0]); return result(newObject("Slot"));
    }
    if (method === "RemoveFromParent") { if (object.parent?.children) object.parent.children = object.parent.children.filter(child => child !== object); object.parent = null; return { __success: true }; }
    if (method === "ClearChildren") { for (const child of object.children || []) child.parent = null; object.children = []; return true; }
    if (method === "GetChildrenCount") return result((object.children || []).length);
    if (method === "GetChildAt") return result(object.children?.[args[0]] || null);
    if (method === "GetScrollOffset") return result(0);
    if (method === "SetIsEnabled") object.enabled = args[0];
    if (method === "SetVisibility") object.visibility = args[0];
    if (method === "AddToViewport") object.inViewport = true;
    if (method === "RemoveFromViewport") object.inViewport = false;
    if (["SetAutoWrapText", "SetVisibility", "SetFont", "Update Chat Background", "SetSize", "SetPadding", "SetWidthOverride",
      "SetAnchors", "SetOffsets", "SetAutoSize", "SetZOrder", "SetBrushColor", "SetIsEnabled", "ScrollToEnd", "SetScrollOffset",
      "SetColorAndOpacity", "SetBackgroundColor", "UnselectMenuItem", "ClearPageTabs",
      "AddToViewport", "RemoveFromViewport", "SetInputMode_GameAndUIEx", "SetInputMode_GameOnly", "SetIgnoreLookInput", "SetIgnoreMoveInput"].includes(method)) return { __success: true };
    throw new Error("Unexpected game call " + method);
  };
  if (options.hub) {
    const list = newObject('ScrollBox'), menu = newObject('MenuItemList_C'); menu.ItemsScrollBox = list; menu.MenuItems = [];
    hub = { IsValid: () => true, GetName: () => 'ModHub_C_0', MenuItemList: menu, PageContainer: newObject('Border') };
    if (options.embeddedHub) hub.parent = newObject('Border');
    hub.ModBP = { IsValid: () => true, GetName: () => 'Mod_ModHub_C_0', Widget_ModHub: hub, RegisteredMods: [] };
  }
  const context = vm.createContext({
    console, Date: Clock, setTimeout: (fn, ms) => ms === 500 ? (uiCallbacks.push(fn), 0) : [100, 2500].includes(ms) ? (hubCallbacks.push(fn), hubCallbacks.length) : [1000, 2000].includes(ms) ? 0 : setTimeout(fn, ms), clearTimeout: id => { if (typeof id === 'number') hubCallbacks[id - 1] = null; else clearTimeout(id); }, AbortController,
    getGameDirectory: () => "fake/FSD",
    readFile: path => path.endsWith('chat-history.json') ? (options.historyRaw || "") : JSON.stringify(fixtureConfig),
    writeFile: (path, value) => { files.set(path, value); if (path.endsWith('/config.json')) fixtureConfig = JSON.parse(value); return true; },
    print: message => logs.push(message),
    GetProperty: (object, key) => options.nullFields ? null : key === "Text" ? object?.value : object?.[key],
    SetProperty: (object, key, value) => { object[key] = value; return true; },
    StaticFindObject: path => { lookups.push(path); return path.includes('/Game/DRGChatTranslatorHub/') ? null : { type: path.split('.').at(-1) }; },
    NewUObject: cls => newObject(cls.type),
    BindDelegateCallback: (object, _name, callback) => { const id = ++bindingSequence; bindings.set(id, { object, callback }); return id; },
    UnbindDelegateCallback: id => bindings.delete(id),
    __umgSetUserWidgetRoot: (object, root) => { object.root = root; },
    __umgDispatchSync: options.noGameDispatcher ? undefined : (object, method, ...args) => {
      onGameThread = true;
      try { return commonCall(object, method, ...args); } finally { onGameThread = false; }
    },
    FindFirstOf: () => owner,
    FindAllInstancesOfClass: name => name === "HUD_Chat_C" ? (chatScans++, [chat]) : name === 'ModHub_C' ? (hub ? [hub] : []) : name === 'Mod_ModHub_C' ? (hubScans++, hub ? [hub.ModBP] : []) : name === "FSDPlayerState" ? (options.players || []).map(name => ({ name, IsValid: () => true, GetName: () => "PlayerState_" + name })) : [],
    CallFunction: commonCall, CallFunctionEx: commonCall,
    RegisterHook: (path, _pre, post) => { events.set(path, post); return [1, 2]; },
    RegisterBindHook: (path, _pre, post) => { events.set(path, post); return [3, 4]; },
    RegisterKeyBind: (key, callback) => { keys.set(key, callback); return true; },
    RegisterLoadMapPreHook: callback => events.set("travel", callback),
    NotifyOnNewObject: (name, callback) => notifications.set(name, callback),
    fetch: (_url, options) => new Promise(resolve => requests.push({ options, resolve })),
  });
  const modules = new Map();
  for (const name of ['core.js', 'history.js', 'chat-ui.js']) modules.set('./' + name, new vm.SourceTextModule(fs.readFileSync(new URL('../js/' + name, import.meta.url), 'utf8'), { context }));
  const main = new vm.SourceTextModule(fs.readFileSync(new URL("../js/main.js", import.meta.url), "utf8"), { context });
  await main.link(name => modules.get(name));
  await main.evaluate();
  // The dispatcher is installed after module evaluation in the actual runtime.
  const initialHubCheck = hubCallbacks.findIndex(fn => typeof fn === 'function');
  if (initialHubCheck >= 0) { const callback = hubCallbacks[initialHubCheck]; hubCallbacks[initialHubCheck] = null; callback(); }
  return { events, keys, calls, requests, logs, input, chat, widgets, files, controller, hub, lookups, notifications, chatScans: () => chatScans, hubScans: () => hubScans,
    refreshHub: () => commonCall(hub.MenuItemList, 'SortItems'),
    pulseHub: () => { const callback = hubCallbacks.find(fn => typeof fn === 'function'); if (callback) { hubCallbacks[hubCallbacks.indexOf(callback)] = null; callback(); } },
    click: caption => {
      for (const { object, callback } of bindings.values()) {
        if (!object.released && object.enabled !== false && object.children?.some(child => child.value === caption)) { callback(); return; }
      }
      throw new Error('No active button: ' + caption);
    },
    advanceUI: ms => { now += ms; const callback = uiCallbacks.shift(); if (callback) callback(); } };
}

test("incoming teammate text only adds a local HUD line", async () => {
  const runtime = await runtimeFixture();
  runtime.events.get("/Script/FSD.FSDGameState:ClientNewMessage")(null, [{ MsgType: 0, Sender: "Teammate", Msg: "ready?", SenderType: 0 }]);
  await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok("准备好了吗？"));
  await turn();
  const translated = runtime.widgets.find(widget => widget.value === "[中译] Teammate：准备好了吗？");
  assert.ok(translated?.parent);
  assert.ok(runtime.calls.every(call => call.method !== "Add Chat Message"));
  assert.ok(runtime.calls.every(call => !/Server_|SendChat|ClientNewMessage/.test(call.method)));
});

test("F8 replaces input before sending; it never invokes a send function", async () => {
  const runtime = await runtimeFixture();
  runtime.keys.get("F8")();
  await turn();
  runtime.requests[0].resolve(ok("Don't call the drop pod yet."));
  await turn();
  assert.equal(runtime.input.value, "Don't call the drop pod yet.");
  assert.ok(runtime.calls.some(call => call.method === "SetText"));
  assert.ok(runtime.calls.every(call => !/Server_|SendChat/.test(call.method)));
});

test("typing during translation keeps the newer input", async () => {
  const runtime = await runtimeFixture();
  runtime.keys.get("F8")();
  await turn();
  runtime.input.value = "我的新消息";
  runtime.requests[0].resolve(ok("old translation"));
  await turn();
  assert.equal(runtime.input.value, "我的新消息");
  assert.ok(!runtime.calls.some(call => call.method === "SetText" && call.object === runtime.input));
});

test("a map change discards a pending outgoing result", async () => {
  const runtime = await runtimeFixture();
  runtime.keys.get("F8")();
  await turn();
  runtime.events.get("travel")();
  runtime.requests[0].resolve(ok("stale translation"));
  await turn();
  assert.equal(runtime.input.value, "先别叫空降舱");
  assert.ok(!runtime.calls.some(call => call.method === "SetText" && call.object === runtime.input));
  assert.ok(runtime.widgets.filter(widget => widget.type === 'TextBlock').every(widget => widget.released));
});

test("failed outgoing API request leaves the original input unchanged", async () => {
  const runtime = await runtimeFixture();
  runtime.keys.get("F8")();
  await turn();
  runtime.requests[0].resolve({ ok: false, status: 429 });
  await turn();
  assert.equal(runtime.input.value, "先别叫空降舱");
  assert.ok(!runtime.calls.some(call => call.method === "SetText" && call.object === runtime.input));
  assert.ok(runtime.logs.every(line => !line.includes(config.ApiKey)));
});

test("F8 reads InputChatBox when focused even if IsChatOpen is false and getter results are wrapped", async () => {
  const runtime = await runtimeFixture({ inputName: "InputChatBox", open: false, wrapped: true, nullFields: true });
  runtime.keys.get("F8")();
  await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok("Wait for the team."));
  await turn();
  assert.equal(runtime.input.value, "Wait for the team.");
});

test("a missing focus getter or text getter does not discard other input checks", async () => {
  const runtime = await runtimeFixture({ inputName: "InputChatBox", getTextFails: true });
  runtime.keys.get("F8")();
  await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok("Ready."));
  await turn();
  assert.equal(runtime.input.value, "Ready.");
});

test("F8 ignores closed unfocused chat boxes and retains readable diagnostics without text or keys", async () => {
  const runtime = await runtimeFixture({ open: false, focused: false, wrapped: true });
  runtime.keys.get("F8")();
  await turn();
  assert.equal(runtime.requests.length, 0);
  const saved = [...runtime.files.values()].at(-1);
  assert.match(saved, /请先打开聊天框/);
  assert.doesNotMatch(saved, /test-key-local-only|先别叫空降舱/);
  assert.equal(JSON.parse(saved).diagnostics[0].length, runtime.input.value.length);
});

test("local lines survive a game history refresh and are released after 45 seconds", async () => {
  const runtime = await runtimeFixture();
  runtime.keys.get("F6")();
  const widget = runtime.widgets[0];
  widget.parent = null; // The original HUD rebuilds ChatMessages from native history.
  runtime.advanceUI(500);
  assert.ok(widget.parent);
  assert.equal(widget.released, undefined);
  runtime.advanceUI(45000);
  assert.equal(widget.parent, null);
  assert.equal(widget.released, true);
  assert.ok(runtime.calls.every(call => call.method !== "Add Chat Message"));
});

const chatEvent = runtime => runtime.events.get('/Script/FSD.FSDGameState:ClientNewMessage');
const historyFile = runtime => JSON.parse([...runtime.files].find(([path]) => path.endsWith('chat-history.json'))[1]);
const uiText = runtime => runtime.widgets.filter(widget => !widget.released && widget.type === 'TextBlock').map(widget => widget.value);

test('local history persists translations and bounds records without persisting credentials', () => {
  let file = '';
  const deps = { path: 'history.json', readFile: () => file, writeFile: (_path, content) => { file = content; return true; }, maxMessages: 2, maxTranslations: 2 };
  const first = createChatHistory(deps);
  first.add('Miner', 'hello'); first.remember('hello', 'zh', '你好');
  const second = createChatHistory(deps);
  assert.equal(second.rows()[0].translation, '你好');
  second.add('Miner', 'ready?'); second.add('Me', '准备好了');
  assert.equal(second.rows().length, 2);
  assert.equal(second.cached('hello', 'zh'), '你好');
  assert.doesNotMatch(file, /ApiKey|Authorization/);
  assert.equal(isPlayerChat({ MsgType: 1, Sender: 'Host', Msg: 'Reminder' }), false);
  assert.equal(isPlayerChat({ MsgType: 'ES_Chat', SenderType: 2, Sender: 'Dev', Msg: 'hello' }), true);
});

test('F9 opening and reopening only show records; manual translation persists and explicit retranslation calls the API', async () => {
  const runtime = await runtimeFixture({ config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Teammate', Msg: 'hello' }]);
  chatEvent(runtime)(null, [{ MsgType: 1, Sender: 'Host', Msg: 'Host reminder' }]);
  runtime.keys.get('F9')(); await turn();
  assert.equal(runtime.requests.length, 0);
  assert.ok(uiText(runtime).includes('hello'));
  assert.ok(!uiText(runtime).includes('Host reminder'));
  runtime.click('翻译'); await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok('你好')); await turn();
  assert.ok(uiText(runtime).includes('你好'));
  const sourceView = runtime.widgets.find(widget => !widget.released && widget.value === 'hello');
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Me', Msg: 'yes' }]);
  assert.equal(sourceView.released, undefined, 'live updates preserve the existing row');
  runtime.click('重新翻译'); await turn();
  assert.equal(runtime.requests.length, 2);
  runtime.requests[1].resolve(ok('您好')); await turn();
  runtime.keys.get('F9')(); runtime.keys.get('F9')(); await turn();
  assert.equal(runtime.requests.length, 2);
  assert.ok(uiText(runtime).includes('您好'));
  assert.equal(historyFile(runtime).messages.length, 2);
  assert.equal(historyFile(runtime).translations.length, 1);
  runtime.keys.get('F9')();
  assert.equal(runtime.controller.bShowMouseCursor, true, 'the previously open chat retains mouse input');
});

test('turning translation off still records player chat and blocks API calls; changes are saved immediately', async () => {
  const runtime = await runtimeFixture();
  runtime.keys.get('F9')(); runtime.click('翻译：开启');
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Teammate', Msg: 'hello' }]);
  await turn();
  assert.equal(runtime.requests.length, 0);
  assert.equal(historyFile(runtime).messages.length, 1);
  const configSaved = JSON.parse([...runtime.files].find(([path]) => path.endsWith('/config.json'))[1]);
  assert.equal(configSaved.Enabled, false);
  assert.equal(configSaved.ApiKey, config.ApiKey);
  assert.ok(uiText(runtime).includes('hello'));
  assert.ok(!uiText(runtime).includes('翻译开关已关闭，聊天记录继续收集。'));
  runtime.click('翻译：关闭');
  await turn();
  assert.equal(runtime.requests.length, 0, 'enabling never bulk-translates old records');
  runtime.keys.get('F9')();
});

test('persisted cache is reused for incoming repeats and F8 with no extra request', async () => {
  let raw = '';
  const history = createChatHistory({ path: 'x', readFile: () => '', writeFile: (_p, value) => { raw = value; return true; },
    scope: () => JSON.stringify(['https://open.bigmodel.cn/api/paas/v4/chat/completions', 'glm-4-flash-250414']) });
  history.remember('hello', 'zh', '你好');
  history.remember('先别叫空降舱', 'en', "Don't call the drop pod yet.");
  const runtime = await runtimeFixture({ historyRaw: raw });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Teammate', Msg: 'hello' }]);
  runtime.keys.get('F8')(); await turn();
  assert.equal(runtime.requests.length, 0);
  assert.equal(runtime.input.value, "Don't call the drop pod yet.");
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Me', Msg: runtime.input.value }]);
  runtime.keys.get('F9')(); await turn();
  assert.ok(uiText(runtime).includes('先别叫空降舱'));
  runtime.keys.get('F9')();
});

test('automatic English and mixed-language chat resumes after saving its own switch', async () => {
  const runtime = await runtimeFixture({ config: { IncomingEnabled: false } });
  runtime.keys.get('F9')(); runtime.click('自动英→中：关闭');
  assert.equal(JSON.parse([...runtime.files].find(([path]) => path.endsWith('/config.json'))[1]).IncomingEnabled, true);
  assert.ok(runtime.logs.some(line => line.includes('自动英→中开启')));
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Me', Msg: 'hello' }]);
  await turn(); assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok('你好')); await turn();
  assert.ok(uiText(runtime).includes('你好'));
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Teammate', Msg: '等一下 please wait' }]);
  await turn(); assert.equal(runtime.requests.length, 2);
  runtime.requests[1].resolve(ok('请稍等')); await turn();
  assert.ok(uiText(runtime).includes('请稍等'));
  runtime.keys.get('F9')();
});

test('clearing chat persists the empty list, retains cached translations and never reuses row ids', async () => {
  const runtime = await runtimeFixture({ config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Miner', Msg: 'hello' }]);
  runtime.keys.get('F9')(); runtime.click('翻译'); await turn();
  const previousId = historyFile(runtime).messages[0].id;
  runtime.click('清空聊天');
  assert.equal(historyFile(runtime).messages.length, 0);
  runtime.requests[0].resolve(ok('你好')); await turn();
  assert.equal(historyFile(runtime).messages.length, 0, 'pending results cannot restore cleared messages');
  assert.equal(historyFile(runtime).translations.length, 1);
  runtime.advanceUI(2000);
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Miner', Msg: 'hello' }]);
  assert.ok(historyFile(runtime).messages[0].id > previousId);
  assert.ok(uiText(runtime).includes('你好'));
  assert.equal(runtime.requests.length, 1);
  runtime.keys.get('F9')();
  const restored = await runtimeFixture({ historyRaw: JSON.stringify(historyFile(runtime)), config: { IncomingEnabled: false } });
  restored.keys.get('F9')(); assert.ok(uiText(restored).includes('你好')); restored.keys.get('F9')();
});

test('large histories use a bounded lazy row pool, cache native lookups, and reopen without new widgets', async () => {
  const saved = { version: 1, sequence: 1000, translations: [], messages: Array.from({ length: 1000 }, (_, index) =>
    ({ id: index + 1, sender: 'Miner', source: 'message ' + index, time: new Date().toISOString() })) };
  const runtime = await runtimeFixture({ historyRaw: JSON.stringify(saved), config: { IncomingEnabled: false } });
  runtime.keys.get('F9')();
  assert.ok(runtime.widgets.some(widget => widget.type === 'UserWidget' && widget.inViewport));
  assert.equal(runtime.widgets.filter(widget => widget.value?.startsWith('message ')).length, 4, 'first open shows four rows before later work');
  await new Promise(resolve => setTimeout(resolve, 90));
  assert.equal(runtime.widgets.filter(widget => widget.value?.startsWith('message ')).length, 16);
  assert.ok(runtime.chatScans() <= 2, 'font lookup does not rescan HUD objects for every label');
  assert.equal(new Set(runtime.lookups).size, runtime.lookups.length, 'each class is resolved once');
  const count = runtime.widgets.length;
  runtime.keys.get('F9')(); runtime.keys.get('F9')();
  assert.equal(runtime.widgets.length, count);
  runtime.click('较早聊天'); assert.equal(runtime.widgets.length, count);
  assert.equal(runtime.requests.length, 0);
  runtime.keys.get('F9')(); runtime.events.get('travel')();
  assert.ok(runtime.widgets.filter(widget => widget.type !== 'Slot').every(widget => widget.released));
});

test('automatic and manual translation of the same message share one request; failed retranslation retains the previous text', async () => {
  const runtime = await runtimeFixture();
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Teammate', Msg: 'hello' }]);
  runtime.keys.get('F9')(); await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok('你好')); await turn();
  runtime.click('重新翻译'); await turn();
  runtime.requests[1].resolve({ ok: false, status: 429 }); await turn();
  assert.ok(uiText(runtime).some(value => value?.includes('你好') && value.includes('限流')));
  assert.equal(historyFile(runtime).translations[0][1], '你好');
  runtime.keys.get('F9')();
});

test('host/system events and unknown fabricated senders are filtered; developer-player chat is allowed', async () => {
  const runtime = await runtimeFixture({ players: ['Me', 'Teammate'], config: { IncomingEnabled: false } });
  const event = chatEvent(runtime);
  event(null, [{ MsgType: 1, Sender: 'Teammate', Msg: 'host reminder' }]);
  event(null, [{ MsgType: 0, Sender: 'HostNotice', Msg: 'fake chat notice' }]);
  event(null, [{ MsgType: 0, SenderType: 2, Sender: 'Teammate', Msg: 'hello' }]);
  assert.equal(historyFile(runtime).messages.length, 1);
  assert.equal(historyFile(runtime).messages[0].source, 'hello');
  assert.equal(runtime.requests.length, 0);
});

test('F9 closing restores game controls and balances only its own input blocks', async () => {
  const runtime = await runtimeFixture({ open: false, focused: false });
  runtime.keys.get('F9')(); runtime.keys.get('F9')();
  assert.equal(runtime.controller.bShowMouseCursor, false);
  for (const method of ['SetIgnoreMoveInput', 'SetIgnoreLookInput']) assert.deepEqual(runtime.calls.filter(call => call.method === method).map(call => call.args[0]), [true, false]);
  assert.ok(runtime.calls.some(call => call.method === 'SetInputMode_GameOnly'));
  assert.equal(runtime.requests.length, 0);
});

test('Mod Hub registers an interface mod and native menu item; sorting and reopening retain it without scans', async () => {
  const runtime = await runtimeFixture({ hub: true, embeddedHub: true, open: false, focused: false });
  assert.ok(uiText(runtime).includes('聊天翻译'));
  assert.equal(runtime.hub.MenuItemList.ItemsScrollBox.children[0].type, 'MenuItem_C');
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
  runtime.refreshHub();
  assert.equal(runtime.hub.MenuItemList.ItemsScrollBox.children[0].type, 'MenuItem_C');
  runtime.click('Chat Translator · 聊天翻译');
  assert.equal(runtime.hub.PageContainer.children[0].type, 'ChatTranslatorPage_C');
  runtime.click('自动英→中：开启');
  assert.equal(JSON.parse([...runtime.files].find(([path]) => path.endsWith('/config.json'))[1]).IncomingEnabled, false);
  runtime.click('聊天记录（F9）');
  assert.ok(uiText(runtime).includes('聊天记录  ·  原文与中文译文'));
  assert.equal(runtime.requests.length, 0);
  runtime.keys.get('F9')();
  const inputMode = runtime.calls.filter(call => call.method === 'SetInputMode_GameAndUIEx').at(-1);
  assert.equal(inputMode.args[1], runtime.hub);
  assert.equal(runtime.controller.bShowMouseCursor, true);
  const scans = runtime.hubScans();
  runtime.events.get('/Game/ModHub/UI/Widgets/ModHub.ModHub_C:Open Hub')(runtime.hub);
  runtime.pulseHub(); runtime.refreshHub();
  assert.equal(runtime.hubScans(), scans);
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
  assert.equal(runtime.hub.MenuItemList.MenuItems.length, 1);
  assert.ok(runtime.logs.some(line => line.includes('原生注册已确认')));
});

test('missing cooked adapter reports failure, preserves F9 and never claims successful registration', async () => {
  const runtime = await runtimeFixture({ hub: true, adapterUnavailable: true, config: { IncomingEnabled: false } });
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 0);
  assert.ok(runtime.logs.some(line => line.includes('适配组件未能加载')));
  assert.ok(!runtime.logs.some(line => line.includes('原生注册已确认')));
  runtime.keys.get('F9')(); assert.ok(uiText(runtime).includes('聊天记录  ·  原文与中文译文')); runtime.keys.get('F9')();
  for (let i = 0; i < 16; i++) runtime.pulseHub();
  const scans = runtime.hubScans(); runtime.pulseHub();
  assert.equal(runtime.hubScans(), scans, 'discovery stops after bounded retries');
  assert.equal(runtime.requests.length, 0);
});

test('native registration recovers a missing native menu item without adding a second mod', async () => {
  const runtime = await runtimeFixture({ hub: true });
  runtime.hub.MenuItemList.MenuItems = [];
  runtime.refreshHub();
  runtime.events.get('/Game/ModHub/UI/Widgets/ModHub.ModHub_C:Open Hub')(runtime.hub);
  runtime.pulseHub();
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
  assert.equal(runtime.hub.MenuItemList.MenuItems.length, 1);
  assert.equal(runtime.hub.MenuItemList.ItemsScrollBox.children.length, 1);
});

test('partial page failure cleans up the unfinished adapter and stops native attempts for this run', async () => {
  const runtime = await runtimeFixture({ hub: true, firstPageCreateFails: true });
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 0);
  assert.ok(runtime.widgets.filter(widget => widget.type === 'ChatTranslatorHub_C').every(widget => widget.released));
  runtime.pulseHub();
  runtime.events.get('/Game/ModHub/UI/Widgets/ModHub.ModHub_C:Open Hub')(runtime.hub);
  runtime.pulseHub(); runtime.events.get('travel')(); runtime.pulseHub();
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 0);
  assert.equal(runtime.calls.filter(call => call.method === 'Create').length, 1);
  runtime.keys.get('F9')(); assert.ok(uiText(runtime).includes('聊天记录  ·  原文与中文译文')); runtime.keys.get('F9')();
});

test('Blueprint loading, object creation and native Mod Hub registration run only on the game thread', async () => {
  const runtime = await runtimeFixture({ hub: true, wrapped: true });
  const nativeCalls = runtime.calls.filter(call => ['GetAsset', 'BeginDeferredActorSpawnFromClass', 'FinishSpawningActor', 'Create', 'RegisterMod'].includes(call.method));
  assert.equal(nativeCalls.filter(call => call.method === 'GetAsset').length, 2);
  assert.ok(nativeCalls.some(call => call.method === 'FinishSpawningActor'));
  assert.ok(nativeCalls.some(call => call.method === 'RegisterMod'));
  assert.ok(nativeCalls.every(call => call.onGameThread));
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
});

test('missing game-thread dispatcher skips unsafe loading while F9 remains usable', async () => {
  const runtime = await runtimeFixture({ hub: true, noGameDispatcher: true });
  assert.ok(!runtime.calls.some(call => ['GetAsset', 'BeginDeferredActorSpawnFromClass', 'FinishSpawningActor', 'Create', 'RegisterMod'].includes(call.method)));
  assert.ok(runtime.logs.some(line => line.includes('本次运行已停止接入')));
  runtime.keys.get('F9')(); assert.ok(uiText(runtime).includes('聊天记录  ·  原文与中文译文')); runtime.keys.get('F9')();
});

test('native loading exception disables retries even after hub reopen and scene changes', async () => {
  const runtime = await runtimeFixture({ hub: true, dispatchFailure: true });
  for (let i = 0; i < 15; i++) runtime.pulseHub();
  runtime.events.get('/Game/ModHub/UI/Widgets/ModHub.ModHub_C:Open Hub')(runtime.hub);
  runtime.pulseHub(); runtime.events.get('travel')(); runtime.pulseHub();
  assert.equal(runtime.calls.filter(call => call.method === 'GetAsset').length, 1);
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 0);
  assert.equal(runtime.requests.length, 0);
});

test('repeated messages from different players share one translation request and both enter history', async () => {
  const runtime = await runtimeFixture();
  const event = chatEvent(runtime);
  event(null, [{ MsgType: 0, Sender: 'Miner1', Msg: 'ready?' }]);
  event(null, [{ MsgType: 0, Sender: 'Miner2', Msg: 'ready?' }]);
  await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok('准备好了吗？')); await turn();
  assert.equal(historyFile(runtime).messages.length, 2);
  assert.equal(historyFile(runtime).translations.length, 1);
});

test('map travel closes F9 and releases the Mod Hub toolbar without removing persisted chat', async () => {
  const runtime = await runtimeFixture({ hub: true, open: false, focused: false, config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Miner', Msg: 'hello' }]);
  runtime.keys.get('F9')();
  runtime.events.get('travel')();
  assert.ok(runtime.widgets.filter(widget => !['Slot', 'CanvasPanel', 'MenuItemList_C', 'MenuItem_C', 'ScrollBox', 'Border'].includes(widget.type) && widget.value !== 'Chat Translator · 聊天翻译').every(widget => widget.released));
  assert.equal(historyFile(runtime).messages.length, 1);
  assert.equal(runtime.requests.length, 0);
});

test('mixed Chinese and English can be translated manually without triggering an automatic request', async () => {
  const runtime = await runtimeFixture({ config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Miner', Msg: '等一下 please wait' }]);
  runtime.keys.get('F9')(); await turn();
  assert.equal(runtime.requests.length, 0);
  runtime.click('翻译'); await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok('请稍等')); await turn();
  assert.ok(uiText(runtime).includes('请稍等'));
  runtime.keys.get('F9')();
});
