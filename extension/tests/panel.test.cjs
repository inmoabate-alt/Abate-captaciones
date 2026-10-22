"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

test("panel: revisión, recuperación de estado y exportación local segura", { timeout: 30000 }, async () => {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 1000 } });
    // Synthetic local fixtures only. No request is forwarded to a remote site.
    await context.route("**/*", async route => {
      const url = new URL(route.request().url());
      const name = url.pathname.slice(1);
      if (url.hostname !== "127.0.0.1" || !["panel.html", "panel.css", "panel.js"].includes(name)) return route.abort();
      await route.fulfill({
        body: await fs.readFile(path.join(__dirname, "..", name)),
        contentType: name.endsWith(".js") ? "application/javascript" : name.endsWith(".css") ? "text/css" : "text/html"
      });
    });
    await context.addInitScript(() => {
      const listeners = [];
      const mock = window.__mock = {
        state: { phase: "idle", records: [] }, messages: [],
        emit(state) {
          this.state = state;
          listeners.forEach(listener => listener({ ABATE_STATE: { newValue: state } }, "local"));
        }
      };
      const source = { id: 11, url: "https://listado.mercadolibre.com.uy/dueno-vende-pocitos", title: "Dueño vende en Pocitos" };
      window.chrome = {
        runtime: {
          async sendMessage(message) {
            mock.messages.push(message);
            if (message.type === "ABATE_START") mock.emit({ ...mock.state, ...message, phase: "running" });
            if (message.type === "ABATE_PAUSE") mock.emit({ ...mock.state, phase: "paused" });
            if (message.type === "ABATE_RESUME") mock.emit({ ...mock.state, phase: "running" });
            if (message.type === "ABATE_CLEAR") mock.emit({ phase: "idle", records: [] });
            return { ok: true, state: mock.state };
          }
        },
        storage: {
          local: { async get() { return { ABATE_STATE: mock.state }; } },
          onChanged: { addListener(listener) { listeners.push(listener); } }
        },
        tabs: {
          async query() { return [source, { id: 12, url: "https://mercadolibre.com.uy.evil.example/", title: "No usar" }]; },
          async get() { return source; },
          onRemoved: { addListener() {} }, onUpdated: { addListener() {} }
        }
      };
    });
    const page = await context.newPage();
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto("http://127.0.0.1/panel.html?sourceTabId=11");
    await page.waitForFunction(() => !document.querySelector("#start").disabled);
    assert.equal(await page.locator("#source-tab option").count(), 2, "a deceptive hostname must not become a source");
    assert.equal(await page.locator("#source-tab").inputValue(), "11");

    await page.getByRole("button", { name: "Empezar revisión" }).click();
    await page.waitForFunction(() => window.__mock.state.phase === "running");
    assert.deepEqual(await page.evaluate(() => window.__mock.messages.find(message => message.type === "ABATE_START")), {
      type: "ABATE_START", tabId: 11, maxListings: 25, maxSearchPages: 10, revealPhone: true
    });
    assert.equal(await page.locator("#source-tab").isDisabled(), true);
    await page.getByRole("button", { name: "Pausar", exact: true }).click();
    await page.waitForFunction(() => window.__mock.state.phase === "paused");
    assert.equal(await page.locator("#resume").isEnabled(), true);

    await page.evaluate(() => window.__mock.emit({
      phase: "error", records: [], detailQueue: ["https://casa.mercadolibre.com.uy/MLU-1234567-prueba-_JM"],
      maxListings: 42, maxSearchPages: 3, revealPhone: false
    }));
    assert.equal(await page.locator("#resume").isEnabled(), true, "a recoverable error must offer continuation");
    assert.equal(await page.locator("#max-listings").inputValue(), "42");
    assert.equal(await page.locator("#max-pages").inputValue(), "3");
    assert.equal(await page.locator("#reveal-phone").isChecked(), false);
    await page.getByRole("button", { name: "Continuar", exact: true }).click();
    await page.waitForFunction(() => window.__mock.state.phase === "running");

    await page.evaluate(() => window.__mock.emit({
      phase: "done", message: "Terminó la prueba.", searchPagesProcessed: 1, detailsProcessed: 2,
      records: [
        {
          id: "MLU1234567", url: "https://casa.mercadolibre.com.uy/MLU-1234567-prueba-_JM",
          title: "<img src=x onerror=alert(1)>", price: "USD 120.000", locationText: "Pocitos, Montevideo",
          pocitosStatus: "confirmed", ownerStatus: "indicated", phone: "+59899123456", phones: ["+59899123456"],
          consent: "No consta", description: '=HYPERLINK("https://example.com")', extra: "  @SUM(1+1)"
        },
        {
          id: "MLU7654321", url: "javascript:alert(1)", title: "Otro aviso", locationText: "Pocitos Nuevo, Montevideo",
          pocitosStatus: "outside", ownerStatus: "uncertain", agencyRefusal: true, phone: ""
        }
      ]
    }));
    assert.equal(await page.locator("#results-body tr").count(), 2);
    assert.equal(await page.locator("#results-body img").count(), 0, "listing content must be rendered as text");
    assert.equal(await page.locator("#results-body a").count(), 1, "a script URL must not become a link");
    assert.equal(await page.locator("#candidates-count").textContent(), "1");
    assert.equal(await page.locator("#start").isDisabled(), true, "a new run must not overwrite existing data");

    const downloaded = page.waitForEvent("download");
    await page.getByRole("button", { name: "Descargar CSV" }).click();
    const download = await downloaded;
    const csv = await fs.readFile(await download.path(), "utf8");
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    for (const expected of ["'+59899123456", "'=HYPERLINK", "'  @SUM", "No consta", "Rechaza inmobiliarias"]) {
      assert.ok(csv.includes(expected), `CSV must contain a safe value: ${expected}`);
    }
    assert.match(download.suggestedFilename(), /^abate-pocitos-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "only the table should scroll horizontally");

    page.once("dialog", dialog => dialog.accept());
    await page.getByRole("button", { name: "Borrar datos", exact: true }).click();
    await page.waitForFunction(() => window.__mock.state.records.length === 0);
    assert.equal(await page.locator("#results-body tr").count(), 0);
    assert.equal(await page.locator("#export-csv").isDisabled(), true);
    assert.deepEqual(pageErrors, []);
  } finally {
    await browser.close();
  }
});
