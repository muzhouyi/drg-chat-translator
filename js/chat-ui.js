// Native UMG widgets; viewing history never submits translation requests.
export function createChatUI(api) {
  let window = null, hubEntry = null, hubTimer = null, font, fontLoaded = false;
  let follow = true, end = 0, hubWarning = false;
  const pageSize = 16, classes = new Map();
  const light = { R: 0.93, G: 0.95, B: 0.98, A: 1 };
  const muted = { R: 0.64, G: 0.73, B: 0.83, A: 1 };
  function live(object) { return api.valid(object); }
  function call(object, method, ...args) { return api.unwrap(api.call(object, method, ...args)); }
  function cls(path) {
    if (!classes.has(path)) classes.set(path, StaticFindObject(path));
    const value = classes.get(path);
    if (!value) throw new Error("Missing widget class");
    return value;
  }
  function context(owner) {
    const widgets = [], bindings = [], values = new Map();
    if (!fontLoaded) { fontLoaded = true; font = api.font && api.font(); }
    const ctx = {
      owner,
      widget(type) {
        const widget = NewUObject(cls("/Script/UMG." + type), owner);
        if (!live(widget)) throw new Error("Cannot create widget");
        widget.AddToRoot(); widgets.push(widget); return widget;
      },
      set(widget, method, value) {
        let saved = values.get(widget);
        if (!saved) { saved = new Map(); values.set(widget, saved); }
        const encoded = JSON.stringify(value);
        if (saved.get(method) === encoded) return;
        call(widget, method, value); saved.set(method, encoded);
      },
      text(value, size = 13, color = light) {
        const widget = ctx.widget("TextBlock");
        ctx.set(widget, "SetText", String(value));
        call(widget, "SetAutoWrapText", true);
        call(widget, "SetColorAndOpacity", { SpecifiedColor: color, ColorUseRule: 0 });
        if (font) call(widget, "SetFont", { ...font, Size: size });
        else SetProperty(widget, "Font.Size", size);
        return widget;
      },
      button(caption, onClick) {
        const widget = ctx.widget("Button"), label = ctx.text(caption, 12);
        call(widget, "SetBackgroundColor", { R: 0.12, G: 0.18, B: 0.25, A: 1 });
        add(widget, label);
        const id = BindDelegateCallback(widget, "OnClicked", () => {
          try { onClick(); } catch (_) { api.notice("界面操作未完成，请查看运行状态。"); }
        });
        if (!(id >= 0)) throw new Error("Cannot bind click event");
        bindings.push(id); return { widget, label };
      },
      dispose() {
        for (const id of bindings) { try { UnbindDelegateCallback(id); } catch (_) {} }
        for (const widget of widgets.slice().reverse()) {
          try { if (live(widget)) call(widget, "RemoveFromParent"); } catch (_) {}
          try { if (live(widget)) widget.RemoveFromRoot(); } catch (_) {}
        }
        bindings.length = 0; widgets.length = 0; values.clear();
      },
    };
    return ctx;
  }
  function add(parent, child, fill = null) {
    const slot = call(parent, "AddChild", child);
    if (live(slot)) {
      try { call(slot, "SetPadding", { Left: 4, Top: 2, Right: 4, Bottom: 2 }); } catch (_) {}
      if (fill != null) { try { call(slot, "SetSize", { SizeRule: 1, Value: fill }); } catch (_) {} }
    }
    return slot;
  }
  function sized(ctx, widget, width) {
    const box = ctx.widget("SizeBox"); call(box, "SetWidthOverride", width); add(box, widget); return box;
  }
  function frame(ctx, child, shade = 0.025, padding = 6) {
    const widget = ctx.widget("Border");
    call(widget, "SetBrushColor", { R: shade, G: shade + 0.01, B: shade + 0.025, A: 0.98 });
    call(widget, "SetPadding", { Left: padding, Top: padding, Right: padding, Bottom: padding });
    add(widget, child); return widget;
  }
  function clearHistory() {
    api.history.clearMessages(); follow = true; end = 0; refreshRows();
  }
  function controls(ctx, parent, includeHistory = false) {
    const enabled = ctx.button("", () => api.setConfig({ Enabled: !api.getConfig().Enabled }));
    const incoming = ctx.button("", () => api.setConfig({ IncomingEnabled: !api.getConfig().IncomingEnabled }));
    add(parent, enabled.widget); add(parent, incoming.widget);
    if (includeHistory) add(parent, ctx.button("聊天记录（F9）", toggle).widget);
    return () => {
      const config = api.getConfig();
      ctx.set(enabled.label, "SetText", "翻译：" + (config.Enabled ? "开启" : "关闭"));
      ctx.set(incoming.label, "SetText", "自动英→中：" + (config.IncomingEnabled ? "开启" : "关闭"));
    };
  }
  function makeRow(current) {
    const ctx = current.ctx, line = ctx.widget("HorizontalBox");
    const view = { row: null, meta: ctx.text("", 11, muted), source: ctx.text(""), translation: ctx.text("") };
    add(line, sized(ctx, view.meta, 108)); add(line, view.source, 1); add(line, view.translation, 1);
    view.action = ctx.button("", () => { if (view.row) api.translateRow(view.row.id, !!view.row.translation); });
    add(line, sized(ctx, view.action.widget, 70));
    view.widget = frame(ctx, line, current.views.length % 2 ? 0.045 : 0.025, 1);
    add(current.scroll, view.widget); current.views.push(view); return view;
  }
  function refreshRows() {
    if (!window || !window.open || !live(window.widget)) return;
    const current = window, ctx = current.ctx, rows = api.history.rows();
    if (follow) end = rows.length;
    end = Math.min(rows.length, Math.max(Math.min(pageSize, rows.length), end));
    const start = Math.max(0, end - pageSize);
    current.visibleRows = rows.slice(start, end);
    ctx.set(current.empty, "SetVisibility", rows.length ? 1 : 0);
    ctx.set(current.pageLabel, "SetText", rows.length ? (start + 1) + "–" + end + " / " + rows.length + " 条" : "0 条");
    ctx.set(current.followLabel, "SetText", follow ? "跟随：开" : "跟随：关");
    current.syncControls();
    renderRows(current);
  }
  function renderRows(current) {
    if (window !== current || !current.open || !live(current.widget)) return;
    const rows = current.visibleRows, ctx = current.ctx;
    // Show the frame and first rows immediately; amortize first-build native calls.
    const limit = Math.min(rows.length, current.views.length + 4);
    while (current.views.length < limit) makeRow(current);
    for (let index = 0; index < current.views.length; index++) {
      const view = current.views[index], row = rows[index];
      ctx.set(view.widget, "SetVisibility", row ? 0 : 1);
      view.row = row || null;
      if (!row) continue;
      const stamp = new Date(row.time);
      const time = [stamp.getHours(), stamp.getMinutes()].map(n => String(n).padStart(2, "0")).join(":");
      ctx.set(view.meta, "SetText", time + "  " + row.sender);
      ctx.set(view.source, "SetText", row.source);
      const state = api.rowState(row.id), english = api.needsTranslation(row.source);
      let translation = row.translation || (english ? "未翻译" : "—");
      if (state.busy) translation += "\n正在翻译…";
      if (state.error) translation += "\n" + state.error;
      ctx.set(view.translation, "SetText", translation);
      ctx.set(view.action.label, "SetText", row.translation ? "重新翻译" : "翻译");
      ctx.set(view.action.widget, "SetIsEnabled", !state.busy && english && row.source.length <= 500 && api.getConfig().Enabled);
      ctx.set(view.action.widget, "SetVisibility", english ? 0 : 1);
    }
    if (follow) { try { call(current.scroll, "ScrollToEnd"); } catch (_) {} }
    if (current.views.length < rows.length && !current.renderTimer) {
      current.renderTimer = setTimeout(() => { current.renderTimer = null; renderRows(current); }, 16);
    }
  }
  function setInput(controller, target) {
    const library = cls("/Script/UMG.Default__WidgetBlueprintLibrary");
    if (!live(controller)) throw new Error("Input controller unavailable");
    if (target) call(library, "SetInputMode_GameAndUIEx", controller, target, 0, false);
    else call(library, "SetInputMode_GameOnly", controller);
  }
  function close() {
    if (!window || !window.open) return;
    const current = window; current.open = false;
    if (current.renderTimer) clearTimeout(current.renderTimer); current.renderTimer = null;
    try { if (live(current.widget)) call(current.widget, "RemoveFromViewport"); } catch (_) {}
    if (live(current.controller) && current.inputChanged) {
      const target = api.restoreTarget && api.restoreTarget();
      try { setInput(current.controller, target); } catch (_) {}
      try { SetProperty(current.controller, "bShowMouseCursor", !!target || current.cursorBefore); } catch (_) {}
      try { if (current.ignoredLook) call(current.controller, "SetIgnoreLookInput", false); } catch (_) {}
      try { if (current.ignoredMove) call(current.controller, "SetIgnoreMoveInput", false); } catch (_) {}
    }
    current.inputChanged = false; current.ignoredLook = false; current.ignoredMove = false;
  }
  function destroyWindow() {
    close(); if (!window) return;
    if (window.unsubscribe) window.unsubscribe();
    window.ctx.dispose(); window = null;
  }
  function buildWindow(owner) {
    const ctx = context(owner), current = { ctx, open: false, views: [], visibleRows: [], renderTimer: null };
    window = current;
    current.widget = ctx.widget("UserWidget"); SetProperty(current.widget, "bIsFocusable", true);
    const canvas = ctx.widget("CanvasPanel"), body = ctx.widget("VerticalBox");
    __umgSetUserWidgetRoot(current.widget, canvas);
    const header = ctx.widget("HorizontalBox");
    add(header, ctx.text("聊天记录  ·  原文与中文译文", 16), 1);
    add(header, ctx.button("清空聊天", clearHistory).widget);
    add(header, ctx.button("关闭（F9）", close).widget); add(body, header);
    const bar = ctx.widget("HorizontalBox"); current.syncControls = controls(ctx, bar); add(body, bar);
    add(body, ctx.text("查看不调用接口；右侧点击翻译。自动英→中仅处理新聊天。", 11, muted));
    const columns = ctx.widget("HorizontalBox");
    add(columns, sized(ctx, ctx.text("时间 / 玩家", 11, muted), 108));
    add(columns, ctx.text("原文", 11, muted), 1); add(columns, ctx.text("中文译文", 11, muted), 1);
    add(columns, sized(ctx, ctx.text("操作", 11, muted), 70)); add(body, columns);
    current.scroll = ctx.widget("ScrollBox"); add(body, current.scroll, 1);
    current.empty = ctx.text("还没有玩家聊天。收到消息后实时显示。", 12, muted); add(current.scroll, current.empty);
    const footer = ctx.widget("HorizontalBox");
    add(footer, ctx.button("较早聊天", () => { follow = false; end -= pageSize; refreshRows(); }).widget);
    add(footer, ctx.button("较新聊天", () => { follow = false; end += pageSize; refreshRows(); }).widget);
    const followButton = ctx.button("", () => { follow = !follow; refreshRows(); });
    current.followLabel = followButton.label; add(footer, followButton.widget);
    current.pageLabel = ctx.text("", 11, muted); add(footer, current.pageLabel, 1);
    add(footer, ctx.button("最新聊天", () => { follow = true; refreshRows(); }).widget); add(body, footer);
    const slot = call(canvas, "AddChildToCanvas", frame(ctx, body));
    if (!live(slot)) throw new Error("Cannot mount UI");
    call(slot, "SetAnchors", { Minimum: { X: 0.16, Y: 0.2 }, Maximum: { X: 0.84, Y: 0.8 } });
    call(slot, "SetOffsets", { Left: 0, Top: 0, Right: 0, Bottom: 0 });
    call(slot, "SetAutoSize", false); call(slot, "SetZOrder", 100);
    current.unsubscribe = api.history.subscribe(refreshRows);
    return current;
  }
  function open() {
    const owner = FindFirstOf("GameInstance"), controller = api.controller();
    if (!live(owner) || !live(controller)) return api.notice("请先进入空间站或任务，再按 F9。");
    try {
      if (window && !live(window.widget)) destroyWindow();
      const current = window || buildWindow(owner);
      current.controller = controller; current.open = true;
      current.cursorBefore = !!api.field(controller, "bShowMouseCursor");
      call(current.widget, "AddToViewport", 2000); current.inputChanged = true;
      setInput(controller, current.widget); SetProperty(controller, "bShowMouseCursor", true);
      call(controller, "SetIgnoreLookInput", true); current.ignoredLook = true;
      call(controller, "SetIgnoreMoveInput", true); current.ignoredMove = true;
      follow = true; end = api.history.rows().length; refreshRows();
    } catch (_) {
      destroyWindow(); api.notice("聊天记录窗口未能打开，请查看运行状态并确认 UE4SS 框架已启用。");
    }
  }
  function toggle() { if (window && window.open) close(); else open(); }
  function showHubPage(entry) {
    if (!live(entry.hub) || !live(entry.pageContainer)) return;
    try { call(entry.menu, "UnselectMenuItem"); } catch (_) {}
    try { call(entry.hub, "ClearPageTabs"); } catch (_) {}
    if (!entry.page) {
      const ctx = context(api.field(entry.hub, "WidgetTree") || entry.hub), body = ctx.widget("VerticalBox");
      entry.page = { ctx, body };
      add(body, ctx.text("聊天翻译", 18));
      add(body, ctx.text("翻译开关控制 F8、手动翻译和自动翻译；关闭后仍记录玩家聊天。", 13, muted));
      const bar = ctx.widget("HorizontalBox"); entry.page.sync = controls(ctx, bar, true); add(body, bar);
      add(body, ctx.text("自动英→中：翻译新收到的英文聊天。F8：将输入框内容译成英文，检查后按回车发送。", 13));
      add(body, ctx.text("F9 查看本地记录，不自动请求接口；可点击翻译或重新翻译。清空聊天保留译文缓存。", 13));
      add(body, ctx.button("清空聊天", clearHistory).widget);
    }
    entry.page.sync();
    call(entry.pageContainer, "ClearChildren"); add(entry.pageContainer, entry.page.body);
  }
  function destroyHub() {
    if (!hubEntry) return;
    if (hubEntry.page) hubEntry.page.ctx.dispose();
    hubEntry.ctx.dispose(); hubEntry = null;
  }
  function checkHub() {
    let selected = null;
    try {
      for (const hub of (api.find("ModHub_C") || []).filter(live)) {
        // Embedded hubs need not be viewport roots. Resolve UObject links one at a time.
        const menu = api.field(hub, "MenuItemList"), list = api.field(menu, "ItemsScrollBox"), page = api.field(hub, "PageContainer");
        if (live(menu) && live(list) && live(page)) selected = { hub, menu, list, page };
        else if (!hubWarning) { hubWarning = true; api.log("Mod Hub 控件尚未就绪，将继续等待 MenuItemList / PageContainer。"); }
      }
    } catch (_) {}
    if (hubEntry && (!selected || !live(hubEntry.hub) || selected.hub.GetName() !== hubEntry.hub.GetName())) destroyHub();
    if (selected && !hubEntry) {
      const ctx = context(api.field(selected.hub, "WidgetTree") || selected.hub);
      try {
        const entry = { ...selected, pageContainer: selected.page, ctx, page: null, button: null };
        entry.button = ctx.button("聊天翻译", () => showHubPage(entry)).widget;
        add(entry.list, entry.button); hubEntry = entry;
        api.log("已接入 Mod Hub 左侧“聊天翻译”入口。");
      } catch (_) { ctx.dispose(); if (!hubWarning) { hubWarning = true; api.log("Mod Hub 入口创建失败，将继续重试。"); } }
    }
    if (hubEntry) {
      try {
        const parent = call(hubEntry.button, "GetParent");
        if (!live(parent) || parent.GetName() !== hubEntry.list.GetName()) add(hubEntry.list, hubEntry.button);
        if (hubEntry.page) hubEntry.page.sync();
      } catch (_) {}
    }
  }
  function scanHub() { hubTimer = null; checkHub(); hubTimer = setTimeout(scanHub, 1000); }
  return {
    toggle, close,
    refresh() { if (hubEntry && hubEntry.page) hubEntry.page.sync(); refreshRows(); },
    startHub() {
      scanHub();
      if (typeof RegisterBindHook === "function") {
        try { RegisterBindHook("/Game/ModHub/UI/Widgets/ModHub.ModHub_C:Open Hub", null, checkHub); } catch (_) {}
      }
    },
    resetScene() { destroyWindow(); destroyHub(); font = null; fontLoaded = false; hubWarning = false; },
    dispose() { destroyWindow(); destroyHub(); if (hubTimer) clearTimeout(hubTimer); hubTimer = null; },
  };
}
