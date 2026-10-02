// Native UMG widgets; viewing history never submits translation requests.
export function createChatUI(api) {
  let window = null, hubEntry = null, hubTimer = null, font, fontLoaded = false;
  let follow = true, end = 0, hubWarning = false, hubCandidate = null, hubRetries = 0, hubFault = false;
  let pageSize = 16;
  let sceneChanging = false;
  let pendingInputRestore = null, openingStage = '';
  const retiredWindows = [];
  const classes = new Map();
  const light = { R: 0.93, G: 0.95, B: 0.98, A: 1 };
  const muted = { R: 0.64, G: 0.73, B: 0.83, A: 1 };
  function live(object) { return api.valid(object); }
  function call(object, method, ...args) {
    if (typeof __umgDispatchAsync === 'function' && /^(?:Set|ScrollTo|ClearChildren|RemoveFrom|K2_DestroyActor)/.test(method)) {
      __umgDispatchAsync(object, method, ...args); return true;
    }
    if (typeof __umgDispatchSync === 'function' && /^(?:AddChild|AddToViewport|GetText|GetParent|IsPressed)/.test(method)) return gameCall(object, method, ...args);
    return api.unwrap(api.call(object, method, ...args));
  }
  function gameCall(object, method, ...args) {
    // CallFunction/CallFunctionEx execute non-network functions on the JS worker.
    // Loading Blueprint classes there can fatal in AssembleReferenceTokenStream.
    // Never fall back to a worker call when the game-thread dispatcher is absent.
    if (typeof __umgDispatchSync !== 'function') throw new Error('game-thread dispatcher unavailable');
    const result = __umgDispatchSync(object, method, ...args);
    if (result && result.__success === false) throw new Error('game-thread call failed');
    return api.unwrap(result);
  }
  function cls(path) {
    if (!classes.has(path)) classes.set(path, StaticFindObject(path));
    const value = classes.get(path);
    if (!value) throw new Error("Missing widget class");
    return value;
  }
  function withBudget(work, milliseconds = 250) {
    return typeof __withExecBudget === "function" ? __withExecBudget(milliseconds, work) : work();
  }
  function context(owner) {
    const widgets = [], bindings = [], values = new Map(), roots = new Map();
    const layout = api.getLayout();
    if (!fontLoaded) { fontLoaded = true; font = api.font && api.font(); }
    const ctx = {
      owner, layout, disposed: false,
      bind(widget, event, handler) {
        openingStage = '绑定控件事件 ' + event;
        const id = BindDelegateCallback(widget, event, (...args) => {
          // Return from the engine delegate before altering its widget tree.
          setTimeout(() => {
            if (ctx.disposed || !live(widget)) return;
            try { withBudget(() => handler(...args)); } catch (_) { api.notice('界面操作未完成；输入内容已保留。'); }
          }, 0);
        });
        if (!(id >= 0)) {
          const error = new Error('Cannot bind ' + event); error.code = 'DELEGATE_UNAVAILABLE'; throw error;
        }
        bindings.push(id); return id;
      },
      widget(type) {
        const widget = NewUObject(cls("/Script/UMG." + type), owner);
        if (!live(widget)) throw new Error("Cannot create widget");
        widget.AddToRoot(); roots.set(widget, widget.RemoveFromRoot.bind(widget)); widgets.push(widget); return widget;
      },
      set(widget, method, value) {
        let saved = values.get(widget);
        if (!saved) { saved = new Map(); values.set(widget, saved); }
        const encoded = JSON.stringify(value);
        if (saved.get(method) === encoded) return;
        call(widget, method, value); saved.set(method, encoded);
      },
      text(value, size = layout.FontSize, color = light) {
        const widget = ctx.widget("TextBlock");
        ctx.set(widget, "SetText", String(value));
        call(widget, "SetAutoWrapText", true);
        call(widget, "SetColorAndOpacity", { SpecifiedColor: color, ColorUseRule: 0 });
        if (font) call(widget, "SetFont", { ...font, Size: size });
        else SetProperty(widget, "Font.Size", size);
        return widget;
      },
      button(caption, onClick) {
        const widget = ctx.widget("Button"), label = ctx.text(caption, layout.ButtonFontSize);
        call(widget, "SetBackgroundColor", { R: 0.12, G: 0.18, B: 0.25, A: 1 });
        add(widget, label);
        ctx.bind(widget, "OnClicked", onClick);
        return { widget, label };
      },
      releaseRoots() {
        // After the native widget tree owns these children, explicit roots would
        // keep their outer page, owning controller and old world alive on travel.
        // Resolve the native method while rooted/alive. A JS UObject IsValid()
        // only probes readable memory; looking up methods on GC'd wrappers can
        // raise an SEH that bypasses JavaScript catch/finally entirely.
        const releases = [...roots.values()];
        roots.clear();
        for (const release of releases) { try { release(); } catch (_) {} }
      },
      dispose(release = true) {
        if (ctx.disposed) return;
        ctx.disposed = true;
        // Take IDs out of our state BEFORE native work. Retrying IDs already
        // removed by the framework trips its Delegate circuit breaker.
        const ids = bindings.splice(0);
        widgets.length = 0; values.clear();
        for (const id of ids) { try { UnbindDelegateCallback(id); } catch (_) {} }
        // The tree owns children. Do not probe or enqueue RemoveFromParent for
        // each old child: LoadMap events reach this worker AFTER native GC too.
        if (release) ctx.releaseRoots();
      },
    };
    return ctx;
  }
  function add(parent, child, fill = null) {
    const slot = call(parent, "AddChild", child);
    if (live(slot)) {
      const gap = window ? window.ctx.layout.Gap : 2;
      try { call(slot, "SetPadding", { Left: gap, Top: gap, Right: gap, Bottom: gap }); } catch (_) {}
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
    add(line, sized(ctx, view.meta, ctx.layout.MetaWidth)); add(line, view.source, ctx.layout.SourceWeight); add(line, view.translation, ctx.layout.TranslationWeight);
    view.action = ctx.button("", () => { if (view.row) api.translateRow(view.row.id, !!view.row.translation); });
    add(line, sized(ctx, view.action.widget, ctx.layout.ActionWidth));
    view.widget = frame(ctx, line, current.views.length % 2 ? 0.045 : 0.025, ctx.layout.RowPadding);
    add(current.scroll, view.widget); current.views.push(view); return view;
  }
  function refreshRows() {
    if (!window || !window.open || window.refreshTimer) return;
    const current = window;
    current.refreshTimer = setTimeout(() => {
      current.refreshTimer = null;
      if (window === current && current.open) withBudget(refreshRowsInner, 1000);
    }, 16);
  }
  function refreshRowsInner() {
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
      current.renderTimer = setTimeout(() => { current.renderTimer = null; withBudget(() => renderRows(current)); }, 16);
    }
  }
  function setInput(controller, target) {
    const library = cls("/Script/UMG.Default__WidgetBlueprintLibrary");
    if (!live(controller)) throw new Error("Input controller unavailable");
    if (target) call(library, "SetInputMode_GameAndUIEx", controller, target, 0, false);
    else call(library, "SetInputMode_GameOnly", controller);
  }
  function close(travel = false) {
    // Native delegates pass (owner, params). Only the explicit internal boolean
    // may select travel cleanup; a button UObject must never do so.
    travel = travel === true;
    if (!window || !window.open) return;
    const current = window; current.open = false;
    if (travel) { if (current.dragTimer) clearTimeout(current.dragTimer); current.dragTimer = null; current.drag = null; }
    else stopDrag(current);
    if (current.refreshTimer) clearTimeout(current.refreshTimer); current.refreshTimer = null;
    if (current.renderTimer) clearTimeout(current.renderTimer); current.renderTimer = null;
    // F9 has GameInstance-owned widgets, so they can stay pinned until the
    // post-load tick. Never queue a raw pointer then unroot it during native GC.
    if (!travel) { try { gameCall(current.widget, "RemoveFromViewport"); } catch (_) {} }
    if (travel && current.inputChanged) {
      pendingInputRestore = { identity: current.controllerIdentity, cursor: current.cursorBefore,
        look: current.ignoredLook, move: current.ignoredMove };
    } else if (!travel && live(current.controller) && current.inputChanged) {
      const target = !travel && api.restoreTarget && api.restoreTarget();
      try { setInput(current.controller, target); } catch (_) {}
      try { SetProperty(current.controller, "bShowMouseCursor", !!target || current.cursorBefore); } catch (_) {}
      try { if (current.ignoredLook) call(current.controller, "SetIgnoreLookInput", false); } catch (_) {}
      try { if (current.ignoredMove) call(current.controller, "SetIgnoreMoveInput", false); } catch (_) {}
    }
    current.inputChanged = false; current.ignoredLook = false; current.ignoredMove = false;
  }
  function destroyWindow(travel = false) {
    close(travel); if (!window) return;
    const current = window; window = null;
    if (current.unsubscribe) current.unsubscribe();
    if (travel) retiredWindows.push(current);
    current.ctx.dispose(!travel);
  }
  function buildWindow(owner) {
    const ctx = context(owner), current = { ctx, open: false, views: [], visibleRows: [], renderTimer: null };
    window = current;
    pageSize = ctx.layout.PageSize;
    current.widget = ctx.widget("UserWidget"); SetProperty(current.widget, "bIsFocusable", true);
    const canvas = ctx.widget("CanvasPanel"), body = ctx.widget("VerticalBox");
    __umgSetUserWidgetRoot(current.widget, canvas);
    const header = ctx.widget("HorizontalBox");
    const title = ctx.button('聊天翻译  ·  按住这里拖动', () => {});
    current.dragButton = title.widget;
    ctx.bind(title.widget, 'OnPressed', () => startDrag(current));
    ctx.bind(title.widget, 'OnReleased', () => stopDrag(current));
    add(header, title.widget, 1);
    add(header, ctx.button('导出聊天', () => {
      try { ctx.set(current.feedback, 'SetText', api.exportChat()); }
      catch (_) { ctx.set(current.feedback, 'SetText', '导出失败，请检查本机目录是否可写。'); }
    }).widget);
    add(header, ctx.button("清空聊天", clearHistory).widget);
    add(header, ctx.button("关闭（F9）", () => close()).widget); add(body, header);
    const bar = ctx.widget("HorizontalBox"); current.syncControls = controls(ctx, bar); add(body, bar);
    add(body, ctx.text("查看不调用接口；右侧点击翻译。自动英→中仅处理新聊天。", 11, muted));
    const columns = ctx.widget("HorizontalBox");
    add(columns, sized(ctx, ctx.text("时间 / 玩家", 11, muted), ctx.layout.MetaWidth));
    add(columns, ctx.text("原文", 11, muted), ctx.layout.SourceWeight); add(columns, ctx.text("中文译文", 11, muted), ctx.layout.TranslationWeight);
    add(columns, sized(ctx, ctx.text("操作", 11, muted), ctx.layout.ActionWidth)); add(body, columns);
    current.scroll = ctx.widget("ScrollBox"); add(body, current.scroll, 1);
    current.empty = ctx.text("还没有玩家聊天。收到消息后实时显示。", 12, muted); add(current.scroll, current.empty);
    const footer = ctx.widget("HorizontalBox");
    add(footer, ctx.button("较早聊天", () => { follow = false; end -= pageSize; refreshRows(); }).widget);
    add(footer, ctx.button("较新聊天", () => { follow = false; end += pageSize; refreshRows(); }).widget);
    const followButton = ctx.button("", () => { follow = !follow; refreshRows(); });
    current.followLabel = followButton.label; add(footer, followButton.widget);
    current.pageLabel = ctx.text("", 11, muted); add(footer, current.pageLabel, 1);
    add(footer, ctx.button("最新聊天", () => { follow = true; refreshRows(); }).widget); add(body, footer);
    current.feedback = ctx.text('输入后按回车或发送；翻译成英文只填入草稿，检查后发送。', 11, muted);
    add(body, current.feedback);
    const compose = ctx.widget('HorizontalBox');
    current.input = ctx.widget('EditableTextBox');
    call(current.input, 'SetHintText', '输入聊天内容（先完成输入法选字）');
    if (font) call(current.input, 'SetFont', { ...font, Size: ctx.layout.FontSize });
    add(compose, current.input, 1);
    ctx.bind(current.input, 'OnTextCommitted', (_object, params) => {
      const commit = params && params[1];
      if (commit === 1 || commit === '1' || commit === 'OnEnter' || commit === 'ETextCommit::OnEnter') sendDraft(current);
    });
    add(compose, ctx.button('翻译成英文', () => translateDraft(current)).widget);
    add(compose, ctx.button('发送', () => sendDraft(current)).widget); add(body, compose);
    current.panel = frame(ctx, body);
    const slot = call(canvas, "AddChildToCanvas", current.panel);
    if (!live(slot)) throw new Error("Cannot mount UI");
    current.slot = slot; applyPosition(current);
    call(slot, "SetOffsets", { Left: 0, Top: 0, Right: 0, Bottom: 0 });
    call(slot, "SetAutoSize", false); call(slot, "SetZOrder", 100);
    current.unsubscribe = api.history.subscribe(refreshRows);
    return current;
  }
  function applyPosition(current) {
    const l = current.ctx.layout;
    call(current.slot, 'SetAnchors', { Minimum: { X: l.X / 100, Y: l.Y / 100 }, Maximum: { X: (l.X + l.Width) / 100, Y: (l.Y + l.Height) / 100 } });
  }
  function mouse(controller, viewport = null) {
    const position = api.call(controller, 'GetMousePosition');
    viewport = viewport || api.call(controller, 'GetViewportSize');
    if (position.ReturnValue !== true || !(viewport.SizeX > 0 && viewport.SizeY > 0)) throw new Error('Mouse position unavailable');
    return { x: Number(position.LocationX) / viewport.SizeX * 100, y: Number(position.LocationY) / viewport.SizeY * 100 };
  }
  function startDrag(current) {
    if (!current.open) return;
    stopDrag(current);
    const viewport = api.call(current.controller, 'GetViewportSize');
    const at = mouse(current.controller, viewport);
    let scale = 1;
    try { scale = Number(gameCall(cls('/Script/UMG.Default__WidgetLayoutLibrary'), 'GetViewportScale', current.widget)) || 1; } catch (_) {}
    current.drag = { at, viewport, scale, checkedAt: 0, x: current.ctx.layout.X, y: current.ctx.layout.Y };
    const pulse = () => {
      current.dragTimer = null;
      if (!current.open || !current.drag || !live(current.controller)) return stopDrag(current);
      try {
        const drag = current.drag;
        // OnReleased normally stops the drag. This low-rate read also catches
        // lost capture/focus without a synchronous game-thread wait every frame.
        if (Date.now() - drag.checkedAt > 150) {
          drag.checkedAt = Date.now();
          if (api.unwrap(api.call(current.dragButton, 'IsPressed')) !== true) return stopDrag(current);
        }
        const point = mouse(current.controller, drag.viewport), layout = current.ctx.layout;
        layout.X = Math.max(0, Math.min(100 - layout.Width, drag.x + point.x - drag.at.x));
        layout.Y = Math.max(0, Math.min(100 - layout.Height, drag.y + point.y - drag.at.y));
        // Render translation avoids remeasuring every chat row on each move.
        current.ctx.set(current.panel, 'SetRenderTranslation', { X: (layout.X - drag.x) / 100 * drag.viewport.SizeX / drag.scale, Y: (layout.Y - drag.y) / 100 * drag.viewport.SizeY / drag.scale });
        current.dragTimer = setTimeout(() => withBudget(pulse), 16);
      } catch (_) { stopDrag(current); }
    };
    current.dragTimer = setTimeout(() => withBudget(pulse), 16);
  }
  function stopDrag(current) {
    if (current.dragTimer) clearTimeout(current.dragTimer); current.dragTimer = null;
    if (!current.drag) return;
    current.drag = null;
    if (live(current.panel) && live(current.slot)) {
      applyPosition(current); current.ctx.set(current.panel, 'SetRenderTranslation', { X: 0, Y: 0 });
    }
    try { api.saveLayout(current.ctx.layout); } catch (_) { api.notice('位置未能保存，本次仍可拖动。'); }
  }
  function draftText(current) { return String(call(current.input, 'GetText') || ''); }
  function sendDraft(current) {
    if (!current.open || current.translating || current.sending) return;
    const source = draftText(current);
    let sent;
    try {
      sent = api.sendChat(source);
    } catch (error) { current.ctx.set(current.feedback, 'SetText', String(error.message || '发送失败，输入已保留。')); return; }
    current.sending = true;
    current.ctx.set(current.feedback, 'SetText', '等待游戏聊天回显…');
    Promise.resolve(sent).then(() => withBudget(() => {
      if (window !== current || !live(current.input)) return;
      if (draftText(current) === source) call(current.input, 'SetText', '');
      current.ctx.set(current.feedback, 'SetText', '游戏已确认收到消息。');
    }), error => withBudget(() => {
      if (window === current) current.ctx.set(current.feedback, 'SetText', String(error.message || '发送失败，草稿保留。'));
    })).then(() => { current.sending = false; }, () => {
      current.sending = false; api.log('F9 发送后的界面更新未完成；消息记录保留。');
    });
    call(current.input, 'SetKeyboardFocus');
  }
  function translateDraft(current) {
    if (!current.open || current.translating) return;
    const source = draftText(current);
    if (!source.trim()) return current.ctx.set(current.feedback, 'SetText', '请先输入需要翻译的文字。');
    current.translating = true;
    current.ctx.set(current.feedback, 'SetText', '正在翻译…原文保留；完成后检查并发送。');
    api.translateDraft(source).then(result => withBudget(() => {
      if (window !== current || !current.open || !live(current.input)) return;
      if (draftText(current) !== source) return current.ctx.set(current.feedback, 'SetText', '输入已变化，保留当前草稿。');
      call(current.input, 'SetText', result);
      current.ctx.set(current.feedback, 'SetText', '英文已填入草稿；检查后按发送。');
    }), error => withBudget(() => {
      if (window === current && current.open) current.ctx.set(current.feedback, 'SetText', error.userMessage || '翻译失败，原文保留。');
    })).then(() => { current.translating = false; }, () => {
      current.translating = false; api.log('F9 翻译后的界面更新未完成；缓存保留。');
    });
  }
  function open() {
    if (sceneChanging) return api.notice('正在切换地图，请加载完成后再打开 F9。');
    const owner = FindFirstOf("GameInstance"), controller = api.controller();
    if (!live(owner) || !live(controller)) return api.notice("请先进入空间站或任务，再按 F9。");
    try {
      openingStage = '创建窗口';
      if (window && !live(window.widget)) destroyWindow();
      const current = window || buildWindow(owner);
      current.controller = controller; current.open = true;
      current.controllerIdentity = typeof controller.GetAddress === 'function' ? String(controller.GetAddress()) : controller.GetName();
      current.cursorBefore = !!api.field(controller, "bShowMouseCursor");
      openingStage = '显示窗口';
      call(current.widget, "AddToViewport", 2000); current.inputChanged = true;
      setInput(controller, current.widget); SetProperty(controller, "bShowMouseCursor", true);
      call(controller, "SetIgnoreLookInput", true); current.ignoredLook = true;
      call(controller, "SetIgnoreMoveInput", true); current.ignoredMove = true;
      follow = true; end = api.history.rows().length; refreshRowsInner();
    } catch (error) {
      const stage = openingStage;
      destroyWindow();
      api.log('F9 窗口打开失败，步骤：' + stage + '；分类：' + (error && (error.code || error.name) || 'UNKNOWN') + '。');
      api.notice(error && error.code === 'DELEGATE_UNAVAILABLE'
        ? '界面按钮接口不可用，可能已被框架停用；请完全退出并重开游戏，F6 无法恢复。'
        : '聊天记录窗口未能打开，失败步骤：' + stage + '。具体诊断已写入运行状态。');
    }
  }
  function toggle() { if (window && window.open) close(); else open(); }
  function loadAdapter(name) {
    const path = '/Game/DRGChatTranslatorHub/' + name;
    const objectPath = path + '.' + name + '_C';
    let type = StaticFindObject(objectPath);
    if (!type) {
      const library = cls('/Script/AssetRegistry.Default__AssetRegistryHelpers');
      type = gameCall(library, 'GetAsset', {
        ObjectPath: objectPath, PackageName: path, PackagePath: '/Game/DRGChatTranslatorHub',
        AssetName: name + '_C', AssetClass: 'BlueprintGeneratedClass',
      });
    }
    if (!live(type)) throw new Error('adapter unavailable');
    return type;
  }
  function buildHubPage(page) {
    const ctx = context(api.field(page, 'WidgetTree') || page), body = ctx.widget('VerticalBox');
    try {
      __umgSetUserWidgetRoot(page, body);
      add(body, ctx.text('聊天翻译', 18));
      add(body, ctx.text('翻译开关控制 F8、手动翻译和自动翻译；关闭后仍记录玩家聊天。', 13, muted));
      const bar = ctx.widget('HorizontalBox'), sync = controls(ctx, bar, true); add(body, bar);
      add(body, ctx.text('自动英→中：翻译新英文。F8：将输入框内容译成英文，检查后按回车发送。', 13));
      add(body, ctx.text('F9 查看本地记录不请求接口；可点击翻译或重新翻译。清空聊天保留缓存。', 13));
      const actions = ctx.widget('HorizontalBox');
      add(actions, ctx.button('清空聊天', clearHistory).widget); add(body, actions);
      sync(); return { ctx, sync };
    } catch (error) { ctx.dispose(); throw error; }
  }
  function same(left, right) {
    return live(left) && live(right) && left.GetName() === right.GetName();
  }
  function registeredItem(host, mod) {
    const registered = api.field(host, 'RegisteredMods');
    const hub = api.field(host, 'Widget_ModHub'), menu = api.field(hub, 'MenuItemList'), items = api.field(menu, 'MenuItems');
    if (!Array.isArray(registered) || !registered.some(value => same(value, mod)) || !Array.isArray(items)) return null;
    const item = items.find(value => same(api.field(value, 'UserMod'), mod));
    return live(item) && same(call(item, 'GetParent'), api.field(menu, 'ItemsScrollBox')) ? item : null;
  }
  function destroyHub(travel = false) {
    if (!hubEntry) return;
    const current = hubEntry; hubEntry = null;
    if (current.page) current.page.ctx.dispose();
    if (current.releasePageRoot) {
      const release = current.releasePageRoot; current.releasePageRoot = null;
      try { release(); } catch (_) {}
    }
    // Scene actors are already retained by their world/native registry. They
    // must not be independently rooted across level teardown.
    // World teardown owns this Actor/page. Never revisit their wrappers after
    // travel; an accessible address can already belong to a different object.
    if (!travel) {
      try { if (live(current.widget)) call(current.widget, 'RemoveFromParent'); } catch (_) {}
      try { if (live(current.mod)) call(current.mod, 'K2_DestroyActor'); } catch (_) {}
    }
  }
  function checkHub() {
    if (hubFault || sceneChanging) return false;
    let host = hubCandidate;
    if (!live(host)) {
      host = (api.find('Mod_ModHub_C') || []).filter(live).find(actor => live(api.field(actor, 'Widget_ModHub'))) || null;
    }
    if (!live(host) || !live(api.field(host, 'Widget_ModHub'))) return false;
    hubCandidate = host;
    if (hubEntry && !same(hubEntry.host, host)) destroyHub();
    if (hubEntry) {
      if (live(registeredItem(host, hubEntry.mod))) return true;
    }
    const owner = FindFirstOf('GameInstance');
    if (!live(owner)) return false;
    let stage = '准备注册';
    try {
      if (!hubEntry) {
        stage = '加载模组接口类'; const modClass = loadAdapter('ChatTranslatorHub');
        stage = '加载设置页接口类'; const pageClass = loadAdapter('ChatTranslatorPage');
        stage = '创建模组实例';
        // Mod Hub's RegisteredMods, AddMenuItem and MenuItem.UserMod are Actor-typed.
        // SetObjectPropertyByName silently refuses a plain UObject for UserMod.
        const gameplay = cls('/Script/Engine.Default__GameplayStatics');
        const transform = { Rotation: { X: 0, Y: 0, Z: 0, W: 1 }, Translation: { X: 0, Y: 0, Z: 0 }, Scale3D: { X: 1, Y: 1, Z: 1 } };
        const deferred = gameCall(gameplay, 'BeginDeferredActorSpawnFromClass', owner, modClass, transform, 1, null);
        if (!live(deferred)) throw new Error('mod Actor creation failed');
        const mod = gameCall(gameplay, 'FinishSpawningActor', deferred, transform);
        if (!live(mod)) throw new Error('mod instance unavailable');
        hubEntry = { host, mod, widget: null, page: null, ready: false, releasePageRoot: null };
        stage = '创建设置页实例';
        const widget = gameCall(cls('/Script/UMG.Default__WidgetBlueprintLibrary'), 'Create', owner, pageClass, api.controller());
        if (!live(widget)) throw new Error('page instance unavailable');
        widget.AddToRoot(); hubEntry.widget = widget; hubEntry.releasePageRoot = widget.RemoveFromRoot.bind(widget);
        stage = '生成设置页控件';
        hubEntry.page = buildHubPage(widget);
        stage = '写入设置页列表';
        if (SetProperty(mod, 'TranslatorPages', [widget]) === false) throw new Error('page assignment failed');
        // Validate compiled interface output before handing it to the native registry.
        stage = '检查编译接口返回值';
        const info = api.call(mod, 'GetModInfo'), pages = api.call(mod, 'GetModPages');
        if (info.ModName !== 'Chat Translator · 聊天翻译' || !Array.isArray(pages.HubPages) || !pages.HubPages.some(value => same(value, widget))) {
          throw new Error('adapter interface output invalid');
        }
        hubEntry.ready = true;
      }
      stage = '检查游戏内接口识别';
      const interfaceClass = cls('/Game/_ModHub/IHubMod.IHubMod_C');
      const implementsMod = gameCall(cls('/Script/Engine.Default__KismetSystemLibrary'), 'DoesImplementInterface', hubEntry.mod, interfaceClass);
      if (implementsMod !== true) throw new Error('native IHubMod cast rejected');
      stage = '调用 RegisterMod';
      gameCall(host, 'RegisterMod', hubEntry.mod);
      stage = '验证原生菜单条目';
      const registered = api.field(host, 'RegisteredMods');
      if (Array.isArray(registered) && registered.some(mod => same(mod, hubEntry.mod)) && !live(registeredItem(host, hubEntry.mod))) {
        gameCall(api.field(host, 'Widget_ModHub'), 'AddModToUI', hubEntry.mod);
      }
      if (!live(registeredItem(host, hubEntry.mod))) {
        const list = api.field(api.field(host, 'Widget_ModHub'), 'MenuItemList');
        const mods = api.field(host, 'RegisteredMods'), items = api.field(list, 'MenuItems');
        const ownItems = Array.isArray(items) ? items.filter(value => same(api.field(value, 'UserMod'), hubEntry.mod)) : [];
        api.log('Mod Hub 注册诊断：模组=' + hubEntry.mod.GetName() + '；已登记=' + (Array.isArray(mods) && mods.some(value => same(value, hubEntry.mod))) + '；自己的条目=' + ownItems.length + '；条目名称=' + ownItems.map(value => String(api.field(value, 'CurrentName') || '(空)')).join(',') + '。');
        throw new Error('native registry confirmation missing');
      }
      api.log('Mod Hub 原生注册已确认：聊天翻译模组、菜单条目和设置页。');
      hubEntry.page.ctx.releaseRoots();
      if (hubEntry.releasePageRoot) { const release = hubEntry.releasePageRoot; hubEntry.releasePageRoot = null; release(); }
      return true;
    } catch (error) {
      hubFault = true;
      if (hubTimer) clearTimeout(hubTimer); hubTimer = null;
      if (hubEntry && !hubEntry.ready) destroyHub();
      if (!hubWarning) { hubWarning = true; api.log('Mod Hub 适配组件未能加载或注册，失败步骤：' + stage + '；原因：' + String(error && error.message || '未知接口异常').slice(0, 200) + '。本次运行已停止接入，请查看框架与组件安装情况。F9 仍可使用。'); }
      return false;
    }
  }
  function scanHub() {
    if (hubFault || sceneChanging) return;
    return withBudget(() => {
      hubTimer = null;
      // Arm a bounded retry before native work; a framework interrupt cannot kill discovery forever.
      if (++hubRetries <= 12) hubTimer = setTimeout(scanHub, 2500);
      if (checkHub() && hubTimer) { clearTimeout(hubTimer); hubTimer = null; }
    }, 500);
  }
  function requestHub(widget = null) {
    if (hubFault || sceneChanging) return;
    // New-object notifications can arrive before construction finishes. Inspect
    // the registry only in the delayed scan, never in the native callback.
    if (hubTimer) clearTimeout(hubTimer);
    hubRetries = 0; hubTimer = setTimeout(scanHub, 100);
  }
  return {
    toggle: () => withBudget(toggle, 1500), close,
    translateInput() { if (!window || !window.open) return false; withBudget(() => translateDraft(window)); return true; },
    refresh() { withBudget(() => { if (hubEntry && hubEntry.page) hubEntry.page.sync(); if (window && window.open) window.syncControls(); refreshRows(); }); },
    reloadLayout() { destroyWindow(); },
    startHub() {
      // Script modules load before the framework installs its UMG dispatcher.
      requestHub();
      // The installed bridge faults while marshaling Open Hub's parameters.
      // Startup/new-widget discovery suffices; avoid that reflection hook.
      if (typeof NotifyOnNewObject === 'function') {
        try { NotifyOnNewObject('ModHub_C', requestHub); } catch (_) {}
        try { NotifyOnNewObject('Mod_ModHub_C', () => requestHub()); } catch (_) {}
      }
    },
    resetScene() {
      sceneChanging = true;
      if (hubTimer) clearTimeout(hubTimer); hubTimer = null;
      destroyWindow(true); destroyHub(true); font = null; fontLoaded = false; hubCandidate = null;
      classes.clear();
    },
    resumeScene() {
      sceneChanging = false; hubFault = false; hubWarning = false;
      for (const current of retiredWindows.splice(0)) {
        try { gameCall(current.widget, 'RemoveFromViewport'); }
        catch (_) { retiredWindows.push(current); continue; }
        current.ctx.releaseRoots();
      }
      const restore = pendingInputRestore; pendingInputRestore = null;
      if (restore) {
        const controller = api.controller();
        if (live(controller)) {
          const identity = typeof controller.GetAddress === 'function' ? String(controller.GetAddress()) : controller.GetName();
          // Seamless travel can retain the controller; otherwise the old
          // controller/input state was destroyed by the engine already.
          if (identity === restore.identity) {
            try { setInput(controller, null); SetProperty(controller, 'bShowMouseCursor', restore.cursor); } catch (_) {}
            try { if (restore.look) call(controller, 'SetIgnoreLookInput', false); } catch (_) {}
            try { if (restore.move) call(controller, 'SetIgnoreMoveInput', false); } catch (_) {}
          }
        }
      }
      requestHub();
    },
    dispose() {
      destroyWindow(); destroyHub(); if (hubTimer) clearTimeout(hubTimer); hubTimer = null;
    },
  };
}
