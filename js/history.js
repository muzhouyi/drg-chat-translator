// Durable local chat and translation cache. Reading/subscribing never calls an API.
export function createChatHistory(deps) {
  const maxMessages = deps.maxMessages || 1000;
  const maxTranslations = deps.maxTranslations || 2000;
  let messages = [], sequence = 0;
  const translations = new Map(), listeners = new Set();
  const scope = () => String(deps.scope ? deps.scope() : "default");
  const key = (source, target) => JSON.stringify([scope(), target, String(source).trim()]);
  function emit() { for (const listener of listeners) { try { listener(); } catch (_) {} } }
  function save() {
    try {
      if (deps.writeFile(deps.path, JSON.stringify({ version: 1, sequence, messages, translations: [...translations] })) === false) throw new Error("save failed");
    } catch (_) { if (deps.onError) deps.onError("聊天记录保存失败；本次仍可在内存中查看。"); }
  }
  try {
    const raw = deps.readFile(deps.path);
    const saved = raw ? JSON.parse(raw.replace(/^\uFEFF/, "")) : null;
    if (saved && saved.version === 1) {
      messages = (Array.isArray(saved.messages) ? saved.messages : []).filter(row =>
        row && Number.isSafeInteger(row.id) && row.id > 0 && typeof row.sender === "string" &&
        row.sender.length <= 160 && typeof row.source === "string" && row.source.length <= 2000 &&
        typeof row.time === "string" && !isNaN(Date.parse(row.time))
      ).slice(-maxMessages).map(row => ({ id: row.id, sender: row.sender, source: row.source, time: row.time }));
      sequence = Math.max(Number.isSafeInteger(saved.sequence) ? saved.sequence : 0, ...messages.map(row => row.id));
      for (const pair of (Array.isArray(saved.translations) ? saved.translations : []).slice(-maxTranslations)) {
        if (Array.isArray(pair) && typeof pair[0] === "string" && pair[0].length < 3000 && typeof pair[1] === "string" && pair[1].length <= 2000) translations.set(pair[0], pair[1]);
      }
    }
  } catch (_) { if (deps.onError) deps.onError("旧聊天记录无法读取，本次记录将重新开始。"); }
  return {
    add(sender, source, time = new Date().toISOString()) {
      if (!String(source).trim() || !String(sender).trim()) return null;
      const row = { id: ++sequence, sender: String(sender).slice(0, 160), source: String(source).slice(0, 2000), time };
      messages.push(row);
      if (messages.length > maxMessages) messages.splice(0, messages.length - maxMessages);
      save(); emit(); return { ...row };
    },
    rows: () => messages.map(row => ({ ...row, translation: translations.get(key(row.source, "zh")) || "" })),
    get: id => { const row = messages.find(row => row.id === id); return row ? { ...row } : null; },
    clearMessages() { messages = []; save(); emit(); },
    cached: (source, target) => translations.get(key(source, target)) || "",
    remember(source, target, value) {
      const cacheKey = key(source, target);
      translations.delete(cacheKey);
      translations.set(cacheKey, String(value));
      while (translations.size > maxTranslations) translations.delete(translations.keys().next().value);
      save(); emit();
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    refresh: emit,
  };
}

export function isPlayerChat(entry) {
  if (!entry || !String(entry.Sender || "").trim() || !String(entry.Msg || "").trim()) return false;
  const type = entry.MsgType;
  return type === 0 || type === "0" || /(?:^|::)ES_Chat$/.test(String(type));
}

export function hasEnglishText(source) {
  return /[a-z]/i.test(source) && !/^https?:\/\/\S+$/i.test(source.trim());
}
