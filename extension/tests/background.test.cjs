"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");

const sourceCode = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const copy = (value) => JSON.parse(JSON.stringify(value));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SEARCH = "https://listado.mercadolibre.com.uy/dueno-vende-pocitos";
const item = (id) => `https://casa.mercadolibre.com.uy/MLU-${id}-dueno-vende-_JM`;

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
    listeners
  };
}

function harness({ savedState, fixtures = {}, initialUrl = SEARCH, redirect } = {}) {
  const store = savedState ? { ABATE_STATE: copy(savedState) } : {};
  const tabs = new Map([[1, { id: 1, url: initialUrl, status: "complete" }]]);
  const messages = [], navigations = [], injections = [];
  let nextTab = 2;
  const onMessage = event(), onUpdated = event(), onRemoved = event();
  const chrome = {
    storage: { local: {
      async get(key) { return { [key]: store[key] ? copy(store[key]) : undefined }; },
      async set(values) { Object.assign(store, copy(values)); }
    } },
    runtime: { onMessage, getURL: (value) => `chrome-extension://abate-test/${value}` },
    action: { onClicked: event() },
    tabs: {
      onUpdated, onRemoved,
      async get(id) {
        if (!tabs.has(id)) throw new Error("Missing tab");
        return copy(tabs.get(id));
      },
      async create(options) {
        const tab = { id: nextTab++, url: options.url, status: "complete" };
        tabs.set(tab.id, tab);
        return copy(tab);
      },
      async update(id, options) {
        const url = redirect ? redirect(options.url) : options.url;
        const tab = { ...tabs.get(id), url, status: "complete" };
        tabs.set(id, tab);
        navigations.push({ id, requested: options.url, url });
        onUpdated.emit(id, { status: "complete" }, copy(tab));
        return copy(tab);
      },
      async remove(id) { tabs.delete(id); onRemoved.emit(id); },
      async sendMessage(id, message) {
        const url = tabs.get(id).url;
        messages.push({ id, url, message: copy(message) });
        const fixture = fixtures[url];
        if (!fixture) throw new Error(`No fixture for ${url}`);
        return copy(typeof fixture === "function" ? fixture(message) : fixture);
      }
    },
    scripting: { async executeScript(options) { injections.push(copy(options)); return []; } }
  };
  vm.runInNewContext(sourceCode, {
    chrome, URL, AbortController, Date, Promise, TextEncoder,
    setTimeout(fn, ms) { return setTimeout(fn, ms === 2000 ? 1 : ms); }, clearTimeout,
    console
  });
  async function message(value, sender = { url: "chrome-extension://abate-test/panel.html", tab: { id: 99 } }) {
    return new Promise((resolve, reject) => {
      const listener = [...onMessage.listeners][0];
      const accepted = listener(value, sender, (result) => resolve(copy(result)));
      if (!accepted) setTimeout(() => reject(new Error("No response")), 100);
    });
  }
  async function state() { return (await message({ type: "ABATE_GET_STATE" })).state; }
  async function until(predicate, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const current = await state();
      if (predicate(current)) return current;
      await pause(5);
    }
    throw new Error(`Timed out; state: ${JSON.stringify(await state())}`);
  }
  return { message, state, until, tabs, messages, navigations, injections, fixtures, chrome };
}

function detail(id, overrides = {}) {
  return {
    kind: "detail", id: `MLU${id}`, url: item(id), title: "Dueño vende",
    price: "USD 200.000", locationText: "Pocitos, Montevideo", description: "Dueño directo.",
    ownerEvidence: "Dueño directo", phone: "+59899123456", phones: ["+59899123456"],
    pocitosStatus: "confirmed", ownerStatus: "indicated", agencyRefusal: false,
    blocked: false, observedAt: "2026-10-22T00:00:00.000Z", ...overrides
  };
}

test("recorre búsqueda y detalles, deduplica y conserva exclusiones sin habilitar envíos", async () => {
  const NEXT = `${SEARCH}?pagina=2`;
  const ids = ["111111", "222222", "333333", "444444", "555555", "666666"];
  const fixtures = {
    [SEARCH]: { kind: "search", blocked: false, itemUrls: [item(ids[0]), `${item(ids[0])}#duplicate`, ...ids.slice(1, 4).map(item)], nextUrl: NEXT },
    [NEXT]: { kind: "search", blocked: false, itemUrls: ids.slice(4).map(item), nextUrl: "" },
    [item(ids[0])]: detail(ids[0]),
    [item(ids[1])]: detail(ids[1], { agencyRefusal: true }),
    [item(ids[2])]: detail(ids[2], { pocitosStatus: "outside" }),
    [item(ids[3])]: detail(ids[3], { ownerStatus: "agency" }),
    [item(ids[4])]: detail(ids[4], { phone: "", phones: [] }),
    [item(ids[5])]: detail(ids[5], { ownerStatus: "uncertain" })
  };
  const h = harness({ fixtures });
  assert.equal((await h.message({ type: "ABATE_START", tabId: 1, maxListings: 10 })).ok, true);
  const state = await h.until((s) => s.phase === "done");
  assert.equal(state.records.length, 6);
  assert.equal(state.searchPagesProcessed, 2);
  assert.equal(state.detailsProcessed, 6);
  assert.equal(new Set(state.records.map((r) => r.id)).size, 6);
  assert.deepEqual(state.records.map((r) => r.reviewStatus), [
    "Candidato para revisión", "Excluido", "Excluido", "Excluido",
    "Pendiente: teléfono no visible", "Pendiente: confirmar dueño directo"
  ]);
  assert.ok(state.records.every((r) => r.consent === "No consta"));
  assert.ok(state.records.filter((r) => r.reviewStatus === "Excluido").every((r) => !r.phone && !r.phones.length));
  assert.equal(h.tabs.get(1).url, SEARCH, "la pestaña fuente permanece intacta");
  assert.ok(h.navigations.every((navigation) => navigation.id !== 1));
  assert.ok(h.messages.every((entry) => entry.message.type === "ABATE_SCAN"));
  assert.ok(h.messages.filter((entry) => entry.message.kind === "detail").every((entry) => entry.message.revealPhone === true));
  const restart = await h.message({ type: "ABATE_START", tabId: 1 });
  assert.equal(restart.ok, false, "no sobrescribe la base guardada");
});

test("se pausa ante verificación, conserva la cola y no reintenta sin orden", async () => {
  const url = item("111111");
  const h = harness({ initialUrl: url, fixtures: {
    [url]: { kind: "detail", blocked: true, blockReason: "Comprobá que sos una persona." }
  } });
  await h.message({ type: "ABATE_START", tabId: 1, revealPhone: false });
  let state = await h.until((s) => s.phase === "paused");
  assert.equal(state.detailQueue.length, 1);
  assert.equal(state.records.length, 0);
  await pause(30);
  assert.equal(h.messages.length, 1, "no hubo reintentos automáticos");
  assert.equal(h.messages[0].message.revealPhone, false);
  h.fixtures[url] = detail("111111");
  assert.equal((await h.message({ type: "ABATE_RESUME" })).ok, true);
  state = await h.until((s) => s.phase === "done");
  assert.equal(state.records.length, 1);
});

test("respeta el límite de avisos y deja constancia de que no revisó todas las páginas", async () => {
  const h = harness({ fixtures: {
    [SEARCH]: { kind: "search", blocked: false, itemUrls: [item("111111"), item("222222")], nextUrl: `${SEARCH}?pagina=2` },
    [item("111111")]: detail("111111")
  } });
  await h.message({ type: "ABATE_START", tabId: 1, maxListings: 1 });
  const state = await h.until((s) => s.phase === "done");
  assert.equal(state.records.length, 1);
  assert.match(state.limitNote, /límite de 1 avisos/);
  assert.equal(h.navigations.length, 2);
});

test("declara el truncamiento de una única página aunque no tenga siguiente", async () => {
  const h = harness({ fixtures: {
    [SEARCH]: { kind: "search", blocked: false, itemUrls: [item("111111"), `${item("111111")}#duplicado`, item("222222")], nextUrl: "" },
    [item("111111")]: detail("111111")
  } });
  await h.message({ type: "ABATE_START", tabId: 1, maxListings: 1 });
  const state = await h.until((s) => s.phase === "done");
  assert.equal(state.records.length, 1);
  assert.match(state.limitNote, /límite de 1 avisos/);
  assert.match(state.limitNote, /otros avisos de esta página sin revisar/);
  assert.deepEqual(state.seenIds, ["MLU111111"]);
  assert.equal(h.navigations.length, 2);
});

test("los duplicados no producen una advertencia falsa de avisos omitidos", async () => {
  const h = harness({ fixtures: {
    [SEARCH]: { kind: "search", blocked: false, itemUrls: [item("111111"), `${item("111111")}#duplicado`], nextUrl: "" },
    [item("111111")]: detail("111111")
  } });
  await h.message({ type: "ABATE_START", tabId: 1, maxListings: 1 });
  const state = await h.until((s) => s.phase === "done");
  assert.equal(state.records.length, 1);
  assert.equal(state.limitNote, "");
});

test("rechaza dominios engañosos y redirecciones externas antes de inyectar scripts", async () => {
  const invalid = harness({ initialUrl: "https://mercadolibre.com.uy.evil.example/MLU-111111" });
  assert.equal((await invalid.message({ type: "ABATE_START", tabId: 1 })).ok, false);
  assert.equal(invalid.navigations.length, 0);
  const redirected = harness({ redirect: () => "https://external.example/login" });
  await redirected.message({ type: "ABATE_START", tabId: 1 });
  const state = await redirected.until((s) => s.phase === "error");
  assert.match(state.message, /fuera de Mercado Libre/);
  assert.equal(redirected.injections.length, 0);
  assert.equal(state.searchQueue.length, 1);
});

test("un reinicio conserva filas y transforma running en paused", async () => {
  const h = harness({ savedState: {
    phase: "running", records: [{ id: "MLU111111", consent: "No consta" }],
    detailQueue: [item("222222")], seenIds: ["MLU111111", "MLU222222"]
  } });
  const state = await h.state();
  assert.equal(state.phase, "paused");
  assert.equal(state.records.length, 1);
  assert.equal(state.detailQueue.length, 1);
  assert.match(state.message, /se reinició/);
  assert.equal(h.navigations.length, 0);
});

test("no reutiliza un ID de pestaña guardado tras reiniciar el navegador", async () => {
  const url = item("111111");
  const h = harness({ savedState: {
    phase: "paused", workerTabId: 1, detailQueue: [url], seenIds: ["MLU111111"]
  }, fixtures: { [url]: detail("111111") } });
  assert.equal((await h.state()).workerTabId, null);
  await h.message({ type: "ABATE_RESUME" });
  await h.until((s) => s.phase === "done");
  assert.equal(h.tabs.get(1).url, SEARCH);
  assert.ok(h.navigations.every((navigation) => navigation.id !== 1));
});

test("las páginas visitadas no pueden enviar órdenes de control al service worker", async () => {
  const h = harness();
  const response = await h.message({ type: "ABATE_START", tabId: 1 }, {
    tab: { id: 1 }, url: SEARCH
  });
  assert.equal(response.ok, false);
  assert.equal((await h.state()).phase, "idle");
  assert.equal(h.navigations.length, 0);
});
