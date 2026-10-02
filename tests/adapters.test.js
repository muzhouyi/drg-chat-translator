import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const load = name => JSON.parse(fs.readFileSync(new URL('../bridge/generated/' + name + '-verified.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const named = (doc, name) => doc.Exports.find(exported => exported.ObjectName === name);
const reference = (doc, id) => id > 0 ? doc.Exports[id - 1] : doc.Imports[-id - 1];
function* walk(value) {
  if (value && typeof value === 'object') {
    if (!Array.isArray(value)) yield value;
    for (const nested of Object.values(value)) yield* walk(nested);
  }
}
test('binary reread preserves the real Mod Hub interfaces and Actor-compatible construction', () => {
  const mod = load('ChatTranslatorHub'), page = load('ChatTranslatorPage');
  const modClass = named(mod, 'ChatTranslatorHub_C'), pageClass = named(page, 'ChatTranslatorPage_C');
  assert.equal(reference(mod, modClass.SuperStruct).ObjectName, 'Actor');
  assert.ok(!modClass.ClassFlags.includes('CLASS_Interface'));
  assert.equal(reference(mod, modClass.Interfaces[0].Class).ObjectName, 'IHubMod_C');
  assert.equal(reference(page, pageClass.Interfaces[0].Class).ObjectName, 'IHubPageWidget_C');
  assert.equal(reference(page, pageClass.SuperStruct).ObjectName, 'UserWidget');
  assert.equal(reference(mod, named(mod, 'Default__ChatTranslatorHub_C').TemplateIndex).ObjectName, 'Default__Actor');
  const iface = reference(mod, modClass.Interfaces[0].Class);
  assert.equal(iface.ClassPackage, '/Script/Engine');
  assert.equal(reference(mod, iface.OuterIndex).ObjectName, '/Game/_ModHub/IHubMod');
});
test('adapter base matches the Actor type required by the real Mod Hub registry and menu', () => {
  // Minimal property types recorded from Mod Hub 1.2.5; no external asset dump is required.
  const types = JSON.parse(fs.readFileSync(new URL('./fixtures/modhub-types.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  for (const [name, property] of [['MenuItem', 'UserMod'], ['ModHub_Mod_ModHub', 'RegisteredMods']]) {
    assert.equal(types[name][property], 'Actor');
  }
  const mod = load('ChatTranslatorHub');
  assert.equal(reference(mod, named(mod, 'ChatTranslatorHub_C').SuperStruct).ObjectName, 'Actor');
});
test('compiled names survive Mod Hub 1.2.5 sorting and UTF-16 Chinese text survives binary serialization', () => {
  const mod = load('ChatTranslatorHub'), page = load('ChatTranslatorPage');
  const getter = named(mod, 'GetModInfo');
  assert.equal(getter.ScriptBytecode[2].Expression.Value.LocalizedSource.Value, '0.2.3');
  const literal = getter.ScriptBytecode[0].Expression.Value.LocalizedSource;
  assert.equal(literal.Value, 'Chat Translator · 聊天翻译');
  assert.ok(literal.Value.charCodeAt(0) <= 256, 'native sorter only visits first character codes 0..256');
  assert.ok(literal.$type.includes('EX_UnicodeStringConst'));
  assert.equal(named(page, 'GetPageInfo').ScriptBytecode[0].Expression.Value.LocalizedSource.Value, 'Settings');
  const output = named(mod, 'GetModPages').ScriptBytecode[0];
  assert.deepEqual(output.Expression.Variable.New.Path, ['TranslatorPages']);
  assert.equal(output.Expression.Variable.New.ResolvedOwner, mod.Exports.indexOf(named(mod, 'ChatTranslatorHub_C')) + 1);
  for (const doc of [mod, page]) {
    for (const value of walk(doc.Exports)) {
      if (value.ResolvedOwner) assert.ok(reference(doc, value.ResolvedOwner), 'all bytecode owner references resolve');
      if (value.Path) for (const name of value.Path) assert.ok(doc.NameMap.includes(name), 'all bytecode field names are serialized');
    }
  }
});
