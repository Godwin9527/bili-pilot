import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function readMessages(locale) {
  return JSON.parse(await readFile(resolve(root, "_locales", locale, "messages.json"), "utf8"));
}

function substitutionSlots(entry) {
  return Object.values(entry.placeholders || {})
    .map((placeholder) => /^\$(\d+)$/.exec(String(placeholder.content || ""))?.[1])
    .filter(Boolean)
    .sort((left, right) => Number(left) - Number(right));
}

function positionalTemplate(entry) {
  return String(entry?.message || "").replace(
    /\$([A-Za-z][A-Za-z0-9_]*)\$/g,
    (match, name) => entry?.placeholders?.[name.toLowerCase()]?.content || match
  );
}

function renderEntry(entry, substitutions = []) {
  const values = Array.isArray(substitutions) ? substitutions : [substitutions];
  return positionalTemplate(entry).replace(
    /\$(\d+)/g,
    (_match, index) => String(values[Number(index) - 1] ?? "")
  );
}

test("all supported locales expose the same non-empty message contract", async () => {
  const locales = {
    en: await readMessages("en"),
    zh_CN: await readMessages("zh_CN"),
    zh_TW: await readMessages("zh_TW")
  };
  const englishKeys = Object.keys(locales.en).sort();
  for (const [locale, messages] of Object.entries(locales)) {
    assert.deepEqual(Object.keys(messages).sort(), englishKeys, `${locale} must expose the English message contract`);
    for (const key of englishKeys) {
      assert.equal(typeof messages[key].message, "string", `${locale}.${key} must be a string`);
      assert.ok(messages[key].message.trim(), `${locale}.${key} must not be empty`);
      assert.doesNotMatch(messages[key].message, /\$\d+/, `${locale}.${key} must use named Chrome placeholders`);
      assert.deepEqual(substitutionSlots(messages[key]), substitutionSlots(locales.en[key]), `${locale}.${key} must preserve substitutions`);
      for (const name of Object.keys(messages[key].placeholders || {})) {
        assert.match(messages[key].message, new RegExp(`\\$${name}\\$`, "i"), `${locale}.${key}.${name} must be referenced`);
      }
    }
  }
});

test("runtime translation follows the Chrome UI locale and preserves substitutions", async () => {
  const englishMessages = await readMessages("en");
  const chinese = await readMessages("zh_CN");
  globalThis.chrome = {
    i18n: {
      getMessage(key, substitutions = []) {
        return renderEntry(chinese[key], substitutions);
      },
      getUILanguage: () => "zh-CN"
    }
  };
  await import(`../i18n.js?locale-test=${Date.now()}`);
  assert.equal(globalThis.BiliCdnI18n.locale, "zh-CN");
  assert.equal(globalThis.BiliCdnI18n.t("routeCount", [3]), renderEntry(chinese.routeCount, [3]));
  assert.equal(globalThis.BiliCdnI18n.t("winnerStable", ["Akamai", "50 Mbps"]), renderEntry(chinese.winnerStable, ["Akamai", "50 Mbps"]));
  const runtimeKeys = Object.keys(globalThis.BiliCdnI18n.english).sort();
  const localeUiKeys = Object.keys(englishMessages).filter((key) => !["extensionDescription", "extensionName"].includes(key)).sort();
  assert.deepEqual(runtimeKeys, localeUiKeys);
  for (const key of runtimeKeys) assert.equal(globalThis.BiliCdnI18n.english[key], positionalTemplate(englishMessages[key]));
  delete globalThis.chrome;
  delete globalThis.BiliCdnI18n;
});

test("every runtime translation key exists in the locale contract", async () => {
  const english = await readMessages("en");
  const sources = await Promise.all([
    readFile(resolve(root, "content.js"), "utf8"),
    readFile(resolve(root, "ui-model.js"), "utf8")
  ]);
  const keys = new Set();
  for (const source of sources) {
    for (const match of source.matchAll(/\b(?:t|localize)\("([A-Za-z][A-Za-z0-9]*)"/g)) keys.add(match[1]);
  }
  const missing = [...keys].filter((key) => !english[key]).sort();
  assert.deepEqual(missing, []);
});
