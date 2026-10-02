import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { createTranslator, describeError } from "../js/core.js";
import { createChatHistory, isPlayerChat } from "../js/history.js";
import { normalizeLayout } from "../js/layout.js";

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
  const events = new Map(), keys = new Map(), calls = [], requests = [], logs = [], files = new Map(), widgets = [], uiCallbacks = [], bindings = new Map(), lookups = [], hubCallbacks = [], notifications = new Map(), deferred = [];
  let inNativeEvent = false;
  const flushDeferred = () => { while (deferred.length) deferred.shift()(); };
  const invokeNativeEvent = (handler, args) => { inNativeEvent = true; try { handler(...args); } finally { inNativeEvent = false; } flushDeferred(); };
  let chatScans = 0, hubScans = 0, pageCreates = 0, onGameThread = false;
  let gameThreadAvailable = true, blockingWaits = 0, interfaceRevision = 0;
  let fixtureConfig = { ...config, ...(options.config || {}) };
  let bindingSequence = 0;
  const unbindAttempts = [], staleReads = [];
  let hub = null;
  const owner = { IsValid: () => true, GetName: () => "GameInstance_0" };
  let now = Date.now();
  class Clock extends Date { static now() { return now; } }
  const input = { value: "先别叫空降舱", IsValid: () => true, GetName: () => "NewChatEdit" };
  const panel = { IsValid: () => true, GetName: () => "ChatMessages" };
  const state = { IsValid: () => true, GetName: () => "PlayerState", name: "Me" };
  const controller = { IsValid: () => true, GetName: () => "LocalPC", PlayerState: state,
    moveBlocks: options.moveBlocks || 0, lookBlocks: options.lookBlocks || 0 };
  const chat = { IsValid: () => true, GetName: () => "HUD_Chat_C_0", IsChatOpen: options.open !== false, ChatMessages: panel,
    [options.inputName || "NewChatEdit"]: input };
  const result = value => options.wrapped ? { ReturnValue: value, __success: true } : value;
  const newObject = (type, outer = null) => {
    const index = widgets.length;
    const widget = { type, outer, children: [], rooted: false,
      IsA: name => name === type, AddToRoot: () => { widget.rooted = true; }, RemoveFromRoot: () => { widget.rooted = false; } };
    for (const name of ['IsValid', 'GetName', 'RemoveFromRoot']) {
      const method = name === 'IsValid' ? () => !widget.destroyed : name === 'GetName' ? () => type + '_' + index : widget.RemoveFromRoot;
      Object.defineProperty(widget, name, { get() {
        if (widget.expired) { staleReads.push({ widget, name }); throw new Error('stale UObject method lookup'); }
        return method;
      } });
    }
    widgets.push(widget); return widget;
  };
  const commonCall = (object, method, ...args) => {
    calls.push({ object, method, args, onGameThread, inNativeEvent });
    if (['GetAsset', 'BeginDeferredActorSpawnFromClass', 'FinishSpawningActor', 'Create', 'RegisterMod', 'AddModToUI'].includes(method) && !onGameThread) {
      throw new Error('native operation on non-game thread');
    }
    if (method === 'GetAsset' && options.dispatchFailure) throw new Error('native loading failed');
    if (method === 'DoesImplementInterface') return result(!options.interfaceRejected && args[1]?.revision === interfaceRevision);
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
    if (method === "RemoveFromParent") { if (object.parent?.children) object.parent.children = object.parent.children.filter(child => child !== object); object.parent = null; object.released = true; return { __success: true }; }
    if (method === 'K2_DestroyActor') { object.destroyed = true; object.released = true; return true; }
    if (method === "ClearChildren") { for (const child of object.children || []) child.parent = null; object.children = []; return true; }
    if (method === "GetChildrenCount") return result((object.children || []).length);
    if (method === "GetChildAt") return result(object.children?.[args[0]] || null);
    if (method === "GetScrollOffset") return result(0);
    if (method === "SetIsEnabled") object.enabled = args[0];
    if (method === "SetVisibility") object.visibility = args[0];
    if (method === "AddToViewport") object.inViewport = true;
    if (method === "RemoveFromViewport") object.inViewport = false;
    if (method === 'GetChatSenderType') return result(options.senderType || 0);
    if (method === 'Server_NewMessage') {
      assert.equal(args[0], 'Me', 'use only the authenticated local player name');
      if (options.sendRejected) return false;
      calls.at(-1).queuedOnGameThread = true;
      if (!options.noEcho) setTimeout(() => events.get('/Game/UI/Chat/HUD_Chat.HUD_Chat_C:NewMesssage')(chat, [{ MsgType: 0, Sender: args[0], Msg: args[1] }]), 0);
      return true;
    }
    if (method === 'GetMousePosition') return { ReturnValue: true, LocationX: controller.mouseX || 400, LocationY: controller.mouseY || 300 };
    if (method === 'GetViewportSize') return { SizeX: 1920, SizeY: 1080 };
    if (method === 'GetViewportScale') return result(1);
    if (method === 'IsInputKeyDown') return !!controller.mouseDown;
    if (method === 'IsPressed') return !!controller.mouseDown;
    if (method === 'SetIgnoreMoveInput' || method === 'SetIgnoreLookInput') {
      const counter = method === 'SetIgnoreMoveInput' ? 'moveBlocks' : 'lookBlocks';
      object[counter] = Math.max(0, object[counter] + (args[0] ? 1 : -1)); return true;
    }
    if (["SetRenderTranslation", "SetHintText", "SetKeyboardFocus", "SetAutoWrapText", "SetVisibility", "SetFont", "Update Chat Background", "SetSize", "SetPadding", "SetWidthOverride",
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
    console, Date: Clock, setTimeout: (fn, ms) => ms === 0 ? (deferred.push(fn), { deferred: true }) : ms === 16 ? setTimeout(fn, 0) : ms === 500 ? (uiCallbacks.push(fn), 0) : [100, 2500].includes(ms) ? (hubCallbacks.push(fn), hubCallbacks.length) : [1000, 2000].includes(ms) ? 0 : setTimeout(fn, ms), clearTimeout: id => { if (typeof id === 'number') hubCallbacks[id - 1] = null; else if (!id?.deferred) clearTimeout(id); }, AbortController,
    getGameDirectory: () => "fake/FSD",
    readFile: path => path.endsWith('chat-history.json') ? (options.historyRaw || "") : path.endsWith('ui-layout.json') ? (files.get(path) || options.layoutRaw || '{}') : JSON.stringify(fixtureConfig),
    writeFile: (path, value) => { files.set(path, value); if (path.endsWith('/config.json')) fixtureConfig = JSON.parse(value); return true; },
    print: message => logs.push(message),
    GetProperty: (object, key) => options.nullFields ? null : key === "Text" ? object?.value : object?.[key],
    SetProperty: (object, key, value) => { object[key] = value; return true; },
    StaticFindObject: path => { lookups.push(path); return path.includes('/Game/DRGChatTranslatorHub/') ? null : { type: path.split('.').at(-1), revision: interfaceRevision }; },
    NewUObject: (cls, outer) => newObject(cls.type, outer),
    BindDelegateCallback: (object, event, callback) => {
      if (options.delegateUnavailable) return -1;
      const id = ++bindingSequence; bindings.set(id, { object, event, callback }); return id;
    },
    UnbindDelegateCallback: id => {
      unbindAttempts.push(id);
      if (!bindings.delete(id)) throw new Error('Callback id not found');
      if (options.firstUnbindThrows && unbindAttempts.length === 1) throw new Error('cleanup interrupted after removing callback');
      return true;
    },
    __umgSetUserWidgetRoot: (object, root) => { object.root = root; },
    __umgDispatchSync: options.noGameDispatcher ? undefined : (object, method, ...args) => {
      if (!gameThreadAvailable) { blockingWaits++; throw new Error('game-thread tick suspended during LoadMap'); }
      onGameThread = true;
      try { return commonCall(object, method, ...args); } finally { onGameThread = false; }
    },
    __umgDispatchAsync: options.noGameDispatcher ? undefined : (object, method, ...args) => {
      onGameThread = true;
      try { const result = commonCall(object, method, ...args); calls.at(-1).asyncMutation = true; return result; } finally { onGameThread = false; }
    },
    FindFirstOf: () => owner,
    FindAllInstancesOfClass: name => name === "HUD_Chat_C" ? (chatScans++, [chat]) : name === 'ModHub_C' ? (hub ? [hub] : []) : name === 'Mod_ModHub_C' ? (hubScans++, hub ? [hub.ModBP] : []) : name === "FSDPlayerState" ? (options.players || []).map(name => ({ name, IsValid: () => true, GetName: () => "PlayerState_" + name })) : [],
    CallFunction: commonCall, CallFunctionEx: commonCall,
    RegisterHook: (path, _pre, post) => { events.set(path, post); return [1, 2]; },
    RegisterBindHook: (path, _pre, post) => { events.set(path, post); return [3, 4]; },
    RegisterKeyBind: (key, callback) => { keys.set(key, callback); return true; },
    RegisterLoadMapPreHook: callback => events.set("travel", callback),
    RegisterLoadMapPostHook: callback => events.set("travelComplete", callback),
    NotifyOnNewObject: (name, callback) => notifications.set(name, callback),
    fetch: (_url, options) => new Promise(resolve => requests.push({ options, resolve })),
  });
  const modules = new Map();
  for (const name of ['core.js', 'history.js', 'chat-ui.js', 'layout.js']) modules.set('./' + name, new vm.SourceTextModule(fs.readFileSync(new URL('../js/' + name, import.meta.url), 'utf8'), { context }));
  const main = new vm.SourceTextModule(fs.readFileSync(new URL("../js/main.js", import.meta.url), "utf8"), { context });
  await main.link(name => modules.get(name));
  await main.evaluate();
  // The dispatcher is installed after module evaluation in the actual runtime.
  const initialHubCheck = hubCallbacks.findIndex(fn => typeof fn === 'function');
  if (initialHubCheck >= 0) { const callback = hubCallbacks[initialHubCheck]; hubCallbacks[initialHubCheck] = null; callback(); }
  return { events, keys, calls, requests, logs, input, chat, widgets, files, controller, hub, lookups, notifications, unbindAttempts, staleReads,
    suspendGameThread: () => { gameThreadAvailable = false; },
    resumeGameThread: () => { gameThreadAvailable = true; }, blockingWaits: () => blockingWaits,
    collectHubPage: () => {
      const mod = hub.ModBP.RegisteredMods[0], page = mod.TranslatorPages[0];
      for (const widget of widgets) if (widget === mod || widget === page || widget.outer === page) {
        assert.equal(widget.rooted, false); widget.expired = true; widget.destroyed = true;
      }
    },
    replaceWorld: () => { interfaceRevision++; if (hub) { for (const mod of hub.ModBP.RegisteredMods) mod.destroyed = true; hub.ModBP.RegisteredMods = []; hub.MenuItemList.MenuItems = []; hub.MenuItemList.ItemsScrollBox.children = []; } },
    delegate: (object, event, params = []) => { for (const item of bindings.values()) if (item.object === object && item.event === event) invokeNativeEvent(item.callback, [object, params]); },
    chatScans: () => chatScans, hubScans: () => hubScans,
    refreshHub: () => commonCall(hub.MenuItemList, 'SortItems'),
    pulseHub: () => { const callback = hubCallbacks.find(fn => typeof fn === 'function'); if (callback) { hubCallbacks[hubCallbacks.indexOf(callback)] = null; callback(); } },
    click: caption => {
      for (const { object, callback, event } of bindings.values()) {
        if (!object.released && object.enabled !== false && (!event || event === 'OnClicked') && object.children?.some(child => child.value === caption)) { invokeNativeEvent(callback, [object, []]); return; }
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
  assert.ok(runtime.widgets.filter(widget => widget.type === 'TextBlock').every(widget => !widget.rooted));
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
  await turn();
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
  runtime.events.get('travelComplete')();
  assert.ok(runtime.widgets.every(widget => !widget.rooted));
  assert.ok(!runtime.widgets.some(widget => widget.inViewport));
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

test('native close-button payload closes the viewport and balances controls across button/key reopen cycles', async () => {
  const runtime = await runtimeFixture({ open: false, focused: false });
  for (let cycle = 0; cycle < 5; cycle++) {
    runtime.keys.get('F9')();
    assert.equal(runtime.controller.moveBlocks, 1); assert.equal(runtime.controller.lookBlocks, 1);
    runtime.click('关闭（F9）');
    assert.ok(!runtime.widgets.some(widget => widget.type === 'UserWidget' && widget.inViewport));
    assert.equal(runtime.controller.bShowMouseCursor, false);
    assert.equal(runtime.controller.moveBlocks, 0); assert.equal(runtime.controller.lookBlocks, 0);
    runtime.keys.get('F9')();
    assert.ok(runtime.widgets.some(widget => widget.type === 'UserWidget' && widget.inViewport));
    runtime.keys.get('F9')();
    assert.equal(runtime.controller.bShowMouseCursor, false);
    assert.equal(runtime.controller.moveBlocks, 0); assert.equal(runtime.controller.lookBlocks, 0);
  }
  assert.equal(runtime.requests.length, 0);
});

test('close button preserves other input blockers and restores an underlying Mod Hub menu', async () => {
  const runtime = await runtimeFixture({ hub: true, open: false, focused: false, moveBlocks: 2, lookBlocks: 1 });
  runtime.controller.bShowMouseCursor = true;
  runtime.click('聊天记录（F9）'); runtime.click('关闭（F9）');
  assert.equal(runtime.controller.moveBlocks, 2); assert.equal(runtime.controller.lookBlocks, 1);
  assert.equal(runtime.controller.bShowMouseCursor, true);
  assert.ok(runtime.calls.some(call => call.method === 'SetInputMode_GameAndUIEx' && call.args[1] === runtime.hub));
  assert.ok(!runtime.widgets.some(widget => widget.type === 'UserWidget' && widget.inViewport));
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
  assert.ok(uiText(runtime).includes('聊天翻译  ·  按住这里拖动'));
  assert.equal(runtime.requests.length, 0);
  runtime.keys.get('F9')();
  const inputMode = runtime.calls.filter(call => call.method === 'SetInputMode_GameAndUIEx').at(-1);
  assert.equal(inputMode.args[1], runtime.hub);
  assert.equal(runtime.controller.bShowMouseCursor, true);
  const scans = runtime.hubScans();
  runtime.notifications.get('ModHub_C')(runtime.hub);
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
  runtime.keys.get('F9')(); assert.ok(uiText(runtime).includes('聊天翻译  ·  按住这里拖动')); runtime.keys.get('F9')();
  for (let i = 0; i < 16; i++) runtime.pulseHub();
  const scans = runtime.hubScans(); runtime.pulseHub();
  assert.equal(runtime.hubScans(), scans, 'discovery stops after bounded retries');
  assert.equal(runtime.requests.length, 0);
});

test('native registration recovers a missing native menu item without adding a second mod', async () => {
  const runtime = await runtimeFixture({ hub: true });
  runtime.hub.MenuItemList.MenuItems = [];
  runtime.refreshHub();
  runtime.notifications.get('ModHub_C')(runtime.hub);
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
  runtime.notifications.get('ModHub_C')(runtime.hub);
  runtime.pulseHub(); runtime.events.get('travel')(); runtime.pulseHub();
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 0);
  assert.equal(runtime.calls.filter(call => call.method === 'Create').length, 1);
  runtime.events.get('travelComplete')();
  runtime.keys.get('F9')(); assert.ok(uiText(runtime).includes('聊天翻译  ·  按住这里拖动')); runtime.keys.get('F9')();
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
  runtime.keys.get('F9')(); assert.ok(uiText(runtime).includes('聊天翻译  ·  按住这里拖动')); runtime.keys.get('F9')();
});

test('native loading exception disables retries even after hub reopen and scene changes', async () => {
  const runtime = await runtimeFixture({ hub: true, dispatchFailure: true });
  for (let i = 0; i < 15; i++) runtime.pulseHub();
  runtime.notifications.get('ModHub_C')(runtime.hub);
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

test('map travel releases callbacks and detaches F9 after loading without removing persisted chat', async () => {
  const runtime = await runtimeFixture({ hub: true, open: false, focused: false, config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Miner', Msg: 'hello' }]);
  runtime.keys.get('F9')();
  const before = runtime.calls.length;
  runtime.events.get('travel')();
  assert.ok(!runtime.calls.slice(before).some(call => /^(RemoveFrom|K2_DestroyActor)/.test(call.method)));
  runtime.events.get('travelComplete')();
  assert.ok(runtime.widgets.every(widget => !widget.rooted));
  assert.ok(!runtime.widgets.some(widget => widget.inViewport));
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

test('local messaging event records own English with teammate-only roster and deduplicates network echo', async () => {
  const runtime = await runtimeFixture({ players: ['Teammate'], config: { IncomingEnabled: false } });
  const own = { MsgType: 0, Sender: 'Me', Msg: 'ready now' };
  runtime.events.get('/Game/UI/Chat/HUD_Chat.HUD_Chat_C:NewMesssage')(runtime.chat, [own]);
  runtime.events.get('/Script/FSD.FSDGameState:ClientNewMessage')(null, [own]);
  assert.equal(historyFile(runtime).messages.length, 1);
  assert.equal(historyFile(runtime).messages[0].sender, 'Me');
  assert.equal(runtime.requests.length, 0);
  assert.ok(!runtime.events.has('/Game/UI/Chat/HUD_Chat.HUD_Chat_C:Add Chat Message'), 'do not listen to history replay');
});

test('F9 draft translation fills English and caches original Chinese; sending is an explicit separate action', async () => {
  const runtime = await runtimeFixture(); runtime.keys.get('F9')();
  const draft = runtime.widgets.find(widget => widget.type === 'EditableTextBox'); draft.value = '准备出发';
  runtime.keys.get('F8')(); await turn();
  assert.equal(runtime.requests.length, 1);
  runtime.requests[0].resolve(ok('Ready to go.')); await turn();
  assert.equal(draft.value, 'Ready to go.');
  assert.ok(runtime.calls.every(call => call.method !== 'Server_NewMessage'));
  assert.ok(!historyFile(runtime).messages.length, 'unsent drafts are not chat');
  runtime.click('发送'); await turn();
  const sent = runtime.calls.filter(call => call.method === 'Server_NewMessage');
  assert.equal(sent.length, 1); assert.deepEqual(Array.from(sent[0].args), ['Me', 'Ready to go.', 0]);
  assert.equal(sent[0].queuedOnGameThread, true); assert.equal(draft.value, '');
  runtime.events.get('/Game/UI/Chat/HUD_Chat.HUD_Chat_C:NewMesssage')(runtime.chat, [{ MsgType: 0, Sender: 'Me', Msg: 'Ready to go.' }]);
  await turn(); assert.equal(runtime.requests.length, 1);
  assert.ok(uiText(runtime).includes('准备出发'));
});

test('editing F9 draft while translation is pending retains the newer input and never sends it', async () => {
  const runtime = await runtimeFixture(); runtime.keys.get('F9')();
  const draft = runtime.widgets.find(widget => widget.type === 'EditableTextBox'); draft.value = '等一下';
  runtime.click('翻译成英文'); await turn(); draft.value = '新版草稿';
  runtime.requests[0].resolve(ok('Wait a moment.')); await turn();
  assert.equal(draft.value, '新版草稿');
  assert.ok(runtime.calls.every(call => call.method !== 'Server_NewMessage'));
});

test('F9 sends ordinary chat with translation disabled, Enter sends once, and focus loss or empty input never sends', async () => {
  const runtime = await runtimeFixture({ config: { Enabled: false } }); runtime.keys.get('F9')();
  const draft = runtime.widgets.find(widget => widget.type === 'EditableTextBox'); draft.value = '普通中文';
  runtime.delegate(draft, 'OnTextCommitted', ['普通中文', 2]);
  assert.equal(runtime.calls.filter(call => call.method === 'Server_NewMessage').length, 0);
  runtime.delegate(draft, 'OnTextCommitted', ['普通中文', 1]);
  runtime.delegate(draft, 'OnTextCommitted', ['', 1]);
  assert.equal(runtime.calls.filter(call => call.method === 'Server_NewMessage').length, 1);
  await turn();
  assert.equal(runtime.requests.length, 0);
});

test('F9 export includes all stored messages and cached Chinese, excludes settings and makes no API request', async () => {
  const saved = JSON.stringify({ version: 1, sequence: 1, messages: [{ id: 1, sender: 'Me', source: 'Hello', time: '2026-10-02T01:00:00Z' }], translations: [] });
  const runtime = await runtimeFixture({ historyRaw: saved, config: { IncomingEnabled: false } });
  runtime.keys.get('F9')(); runtime.click('导出聊天');
  const exports = [...runtime.files].filter(([path]) => path.endsWith('.txt'));
  assert.equal(exports.length, 1); assert.match(exports[0][1], /Me\r\n原文：Hello/);
  assert.equal(exports[0][1].charCodeAt(0), 0xFEFF);
  assert.doesNotMatch(exports[0][1], /test-key|ApiKey|Endpoint|glm-/);
  assert.equal(runtime.requests.length, 0);
});

test('F9 mouse dragging updates anchored position, clamps to viewport, and persists only UI layout', async () => {
  const runtime = await runtimeFixture(); runtime.keys.get('F9')();
  const title = runtime.widgets.find(widget => widget.children?.some(child => child.value === '聊天翻译  ·  按住这里拖动'));
  runtime.controller.mouseDown = true; runtime.delegate(title, 'OnPressed');
  runtime.controller.mouseX = 1900; runtime.controller.mouseY = 1000;
  await new Promise(resolve => setTimeout(resolve, 45));
  runtime.controller.mouseDown = false; runtime.delegate(title, 'OnReleased');
  const saved = JSON.parse([...runtime.files].find(([path]) => path.endsWith('ui-layout.json'))[1]);
  assert.equal(saved.X, 100 - saved.Width); assert.equal(saved.Y, 100 - saved.Height);
  assert.ok(![...runtime.files.keys()].some(path => path.endsWith('/config.json')));
  assert.equal(runtime.requests.length, 0);
});

test('layout editor values affect row count and sizes, reload rebuilds safely without requesting translations', async () => {
  const messages = Array.from({ length: 20 }, (_, index) => ({ id: index + 1, sender: 'Me', source: '文字 ' + index, time: '2026-10-02T01:00:00Z' }));
  const runtime = await runtimeFixture({ layoutRaw: JSON.stringify({ PageSize: 8, Width: 80, MetaWidth: 150 }), historyRaw: JSON.stringify({ version: 1, sequence: 20, messages, translations: [] }) });
  runtime.keys.get('F9')(); await new Promise(resolve => setTimeout(resolve, 40));
  assert.ok(uiText(runtime).includes('13–20 / 20 条'));
  assert.ok(runtime.calls.some(call => call.method === 'SetWidthOverride' && call.args[0] === 150));
  assert.equal(runtime.requests.length, 0);
  runtime.keys.get('F6')(); runtime.keys.get('F9')();
  assert.equal(runtime.requests.length, 0);
});

test('invalid layout numbers are bounded and panel stays within viewport', () => {
  const layout = normalizeLayout({ Width: 200, Height: -10, X: 80, Y: 80, FontSize: 'bad', Gap: -1, PageSize: 999 });
  assert.equal(layout.Width, 95); assert.equal(layout.Height, 40); assert.equal(layout.X, 5); assert.equal(layout.Y, 60);
  assert.equal(layout.FontSize, 13); assert.equal(layout.Gap, 0); assert.equal(layout.PageSize, 32);
  assert.deepEqual(normalizeLayout(null), normalizeLayout());
});

test('RPC rejection retains draft and no unconfirmed message is recorded', async () => {
  const runtime = await runtimeFixture({ sendRejected: true }); runtime.keys.get('F9')();
  const draft = runtime.widgets.find(widget => widget.type === 'EditableTextBox'); draft.value = '保留我的草稿';
  runtime.click('发送'); await turn();
  assert.equal(draft.value, '保留我的草稿'); assert.ok(uiText(runtime).includes('游戏聊天入口调用失败，草稿保留。'));
  assert.ok(![...runtime.files.keys()].some(path => path.endsWith('chat-history.json')));
});

test('pending send clears only on local echo and preserves edits made while awaiting confirmation', async () => {
  const runtime = await runtimeFixture({ noEcho: true }); runtime.keys.get('F9')();
  const draft = runtime.widgets.find(widget => widget.type === 'EditableTextBox'); draft.value = '等待回显';
  runtime.click('发送'); await turn(); assert.equal(draft.value, '等待回显');
  draft.value = '新的草稿';
  runtime.events.get('/Game/UI/Chat/HUD_Chat.HUD_Chat_C:NewMesssage')(runtime.chat, [{ MsgType: 0, Sender: 'Me', Msg: '等待回显' }]);
  await turn(); assert.equal(draft.value, '新的草稿'); assert.equal(historyFile(runtime).messages.length, 1);
});

test('drag and export avoid unsupported native key structs and non-ASCII export filenames', async () => {
  const runtime = await runtimeFixture(); runtime.keys.get('F9')();
  const title = runtime.widgets.find(widget => widget.children?.some(child => child.value === '聊天翻译  ·  按住这里拖动'));
  runtime.controller.mouseDown = true; runtime.delegate(title, 'OnPressed');
  await new Promise(resolve => setTimeout(resolve, 40)); runtime.controller.mouseDown = false; runtime.delegate(title, 'OnReleased');
  assert.ok(runtime.calls.some(call => call.method === 'IsPressed'));
  assert.ok(runtime.calls.every(call => call.method !== 'IsInputKeyDown'));
  runtime.click('导出聊天');
  const exported = [...runtime.files.keys()].find(path => path.endsWith('.txt'));
  assert.match(exported.split('/').at(-1), /^chat-export-[\x00-\x7f]+\.txt$/);
});

test('UMG mutations and viewport mounting execute on the game thread after the native delegate returns', async () => {
  const runtime = await runtimeFixture({ config: { IncomingEnabled: false } }); runtime.keys.get('F9')();
  const draft = runtime.widgets.find(widget => widget.type === 'EditableTextBox'); draft.value = '稳定性测试';
  runtime.click('发送'); await turn();
  const mutations = runtime.calls.filter(call => /^(Set|AddChild|RemoveFrom|AddToViewport|ScrollTo|ClearChildren)/.test(call.method));
  assert.ok(mutations.length > 30);
  assert.ok(mutations.every(call => call.onGameThread), 'Slate mutations must not execute on JS worker');
  assert.ok(mutations.every(call => !call.inNativeEvent), 'do not mutate widget tree inside native click/commit delegate');
  assert.ok(mutations.some(call => call.asyncMutation && call.method === 'SetText'));
  runtime.keys.get('F9')(); runtime.keys.get('F9')();
  const mounts = runtime.calls.filter(call => /^(AddToViewport|RemoveFromViewport)$/.test(call.method));
  assert.ok(mounts.every(call => call.onGameThread));
});

test('messages coalesce F9 refreshes instead of constructing native rows inside a chat callback', async () => {
  const runtime = await runtimeFixture({ config: { IncomingEnabled: false } }); runtime.keys.get('F9')();
  const before = runtime.widgets.length;
  for (let index = 0; index < 6; index++) chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Me', Msg: '测试 '+index }]);
  assert.equal(runtime.widgets.length, before, 'chat receipt only saves data and schedules a frame');
  await turn();
  assert.ok(runtime.widgets.length > before); assert.equal(historyFile(runtime).messages.length, 6);
  assert.equal(runtime.requests.length, 0);
});

test('drag moves only render translation while held and commits anchors once on release', async () => {
  const runtime = await runtimeFixture(); runtime.keys.get('F9')();
  const title = runtime.widgets.find(widget => widget.children?.some(child => child.value === '聊天翻译  ·  按住这里拖动'));
  const anchorCount = () => runtime.calls.filter(call => call.method === 'SetAnchors').length;
  const before = anchorCount(); runtime.controller.mouseDown = true; runtime.delegate(title, 'OnPressed');
  runtime.controller.mouseX = 500; await new Promise(resolve => setTimeout(resolve, 25));
  runtime.controller.mouseX = 600; await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(anchorCount(), before, 'moving must not reflow the whole panel');
  assert.ok(runtime.calls.filter(call => call.method === 'SetRenderTranslation').length >= 2);
  runtime.controller.mouseDown = false; runtime.delegate(title, 'OnReleased');
  assert.equal(anchorCount(), before + 1);
  const setters = runtime.calls.filter(call => call.method === 'SetRenderTranslation');
  assert.ok(setters.every(call => call.asyncMutation));
  assert.deepEqual(JSON.parse(JSON.stringify(setters.at(-1).args[0])), { X: 0, Y: 0 });
});

test('Mod Hub discovery avoids unsafe Blueprint parameter reflection and premature object inspection', async () => {
  const runtime = await runtimeFixture({ hub: true });
  assert.ok(![...runtime.events.keys()].some(path => path.includes('/ModHub/') || path.includes('/DRGChatTranslatorHub/')));
  const unfinished = new Proxy({}, { get() { throw new Error('new object is not initialized'); } });
  assert.doesNotThrow(() => runtime.notifications.get('ModHub_C')(unfinished));
  runtime.pulseHub();
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
  assert.equal(runtime.hub.MenuItemList.MenuItems.length, 1);
  assert.ok(runtime.events.has('/Game/UI/Chat/HUD_Chat.HUD_Chat_C:NewMesssage'), 'retain local chat recording');
});

test('repeated F6 reloads retain the existing Mod Hub Actor and settings page while rebuilding F9 layout', async () => {
  const runtime = await runtimeFixture({ hub: true });
  const mod = runtime.hub.ModBP.RegisteredMods[0], page = mod.TranslatorPages[0];
  for (let index = 0; index < 6; index++) {
    runtime.keys.get('F9')();
    runtime.keys.get('F6')();
    runtime.pulseHub();
  }
  assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
  assert.equal(runtime.hub.ModBP.RegisteredMods[0], mod);
  assert.equal(mod.TranslatorPages[0], page);
  assert.ok(!mod.released && !page.released);
  assert.equal(runtime.calls.filter(call => call.method === 'FinishSpawningActor').length, 1);
  runtime.click('Chat Translator · 聊天翻译');
  assert.equal(runtime.hub.PageContainer.children[0], page);
  runtime.click('自动英→中：开启');
  assert.equal(JSON.parse([...runtime.files].find(([path]) => path.endsWith('/config.json'))[1]).IncomingEnabled, false);
  assert.equal(runtime.requests.length, 0);
});

test('map teardown never touches old world UI or waits on a suspended game thread; post-load restores controls', async () => {
  const runtime = await runtimeFixture({ hub: true });
  runtime.keys.get('F6')(); runtime.keys.get('F9')();
  const owned = runtime.widgets.filter(widget => widget.rooted);
  assert.ok(owned.length > 30);
  const title = runtime.widgets.find(widget => widget.children?.some(child => child.value === '聊天翻译  ·  按住这里拖动'));
  runtime.controller.mouseDown = true; runtime.delegate(title, 'OnPressed');
  const before = runtime.calls.length;
  runtime.suspendGameThread();
  runtime.events.get('travel')();
  assert.equal(runtime.blockingWaits(), 0, 'travel cleanup must never enqueue a synchronous wait');
  assert.equal(runtime.calls.length, before, 'do not enqueue raw old-world pointers during GC');
  const removals = runtime.calls.slice(before).filter(call => /^(RemoveFrom|K2_DestroyActor)/.test(call.method));
  assert.equal(removals.length, 0);
  runtime.keys.get('F9')(); runtime.pulseHub();
  assert.equal(runtime.blockingWaits(), 0, 'F9 and registry scans remain paused while loading');
  assert.ok(runtime.logs.some(line => line.includes('地图切换开始')));
  runtime.resumeGameThread(); runtime.events.get('travelComplete')();
  assert.equal(runtime.controller.bShowMouseCursor, false);
  const unblocks = runtime.calls.slice(before).filter(call => ['SetIgnoreLookInput', 'SetIgnoreMoveInput'].includes(call.method));
  assert.equal(unblocks.length, 2); assert.ok(unblocks.every(call => call.args[0] === false && call.asyncMutation));
  assert.ok(owned.every(widget => !widget.rooted), 'GameInstance F9 widgets unroot only after removal is confirmed');
});

test('Mod Hub page and children are retained by their native owners rather than explicit roots', async () => {
  const runtime = await runtimeFixture({ hub: true });
  const mod = runtime.hub.ModBP.RegisteredMods[0], page = mod.TranslatorPages[0];
  assert.equal(mod.rooted, false);
  assert.equal(page.rooted, false);
  assert.ok(runtime.widgets.every(widget => !widget.rooted));
  runtime.click('Chat Translator · 聊天翻译'); runtime.click('自动英→中：开启');
  assert.equal(JSON.parse([...runtime.files].find(([path]) => path.endsWith('/config.json'))[1]).IncomingEnabled, false);
});

test('completed map loading reacquires interface classes and registers only one mod in each new world', async () => {
  const runtime = await runtimeFixture({ hub: true, config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Me', Msg: '保留这条聊天' }]);
  const firstMod = runtime.hub.ModBP.RegisteredMods[0];
  for (let index = 0; index < 3; index++) {
    runtime.keys.get('F9')(); runtime.events.get('travel')();
    runtime.replaceWorld(); runtime.pulseHub();
    assert.equal(runtime.hub.ModBP.RegisteredMods.length, 0, 'do not register while the new world is still loading');
    runtime.events.get('travelComplete')(); runtime.pulseHub();
    assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
    assert.equal(runtime.hub.MenuItemList.MenuItems.length, 1);
    assert.ok(!runtime.hub.ModBP.RegisteredMods[0].rooted);
    assert.equal(runtime.requests.length, 0);
  }
  assert.ok(firstMod.destroyed);
  assert.equal(runtime.lookups.filter(path => path === '/Game/_ModHub/IHubMod.IHubMod_C').length, 4);
  assert.equal(historyFile(runtime).messages.length, 1);
  assert.ok(runtime.logs.some(line => line.includes('地图加载完成')));
  assert.ok(!runtime.logs.some(line => line.includes('native IHubMod cast rejected')));
});

test('a delayed travel notification after native GC never reads expired Mod Hub UObject wrappers', async () => {
  const runtime = await runtimeFixture({ hub: true, config: { IncomingEnabled: false } });
  chatEvent(runtime)(null, [{ MsgType: 0, Sender: 'Me', Msg: 'keep this record' }]);
  for (let cycle = 0; cycle < 6; cycle++) {
    runtime.collectHubPage(); // Native GC can precede the worker's queued pre-hook.
    const before = runtime.calls.length;
    runtime.events.get('travel')(); runtime.events.get('travel')();
    assert.equal(runtime.staleReads.length, 0, 'even IsValid/GetName method lookup is unsafe after GC');
    assert.equal(runtime.calls.length, before, 'do not queue old Actor/page removal');
    runtime.replaceWorld(); runtime.events.get('travelComplete')(); runtime.pulseHub();
    assert.equal(runtime.hub.ModBP.RegisteredMods.length, 1);
    runtime.keys.get('F9')();
    assert.ok(runtime.widgets.some(widget => widget.type === 'UserWidget' && widget.inViewport));
    runtime.keys.get('F9')();
  }
  assert.equal(runtime.staleReads.length, 0);
  assert.equal(new Set(runtime.unbindAttempts).size, runtime.unbindAttempts.length);
  assert.equal(historyFile(runtime).messages.length, 1);
  assert.equal(runtime.requests.length, 0);
});

test('cleanup interrupted after native unbind never retries the already removed callback id', async () => {
  const runtime = await runtimeFixture({ hub: true, firstUnbindThrows: true });
  runtime.keys.get('F9')();
  runtime.events.get('travel')(); runtime.events.get('travelComplete')();
  runtime.replaceWorld(); runtime.pulseHub(); runtime.keys.get('F9')();
  runtime.keys.get('F6')(); runtime.events.get('travel')(); runtime.events.get('travelComplete')();
  assert.equal(new Set(runtime.unbindAttempts).size, runtime.unbindAttempts.length);
  assert.ok(runtime.widgets.every(widget => !widget.rooted));
});

test('unavailable native delegates report the failed step and restart requirement without blaming missing UE4SS', async () => {
  const runtime = await runtimeFixture({ delegateUnavailable: true });
  runtime.keys.get('F9')(); runtime.keys.get('F9')(); runtime.keys.get('F6')(); runtime.keys.get('F9')();
  assert.ok(runtime.logs.some(line => line.includes('绑定控件事件 OnClicked') && line.includes('DELEGATE_UNAVAILABLE')));
  assert.ok(runtime.logs.some(line => line.includes('F6 无法恢复')));
  assert.ok(!runtime.logs.some(line => line.includes('确认 UE4SS 框架已启用')));
  assert.ok(runtime.widgets.filter(widget => widget.type !== 'TextBlock').every(widget => !widget.rooted), 'failed F9 leaves no retained window; diagnostic HUD labels remain visible');
  assert.equal(runtime.requests.length, 0);
});
