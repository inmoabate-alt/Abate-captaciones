const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const extensionPath = path.resolve(__dirname, '..');
const searchUrl = 'https://listado.mercadolibre.com.uy/dueno-vende-pocitos';
const detailUrl = (id) => `https://apartamento.mercadolibre.com.uy/MLU-${id}-dueno-vende-_JM`;

function installationRestriction() {
  // La integración sigue disponible en un navegador que admita extensiones locales.
  // No se alteran ni se eluden las políticas administradas del navegador de pruebas.
  const policyFile = '/etc/chromium/policies/managed/extensions.json';
  try {
    const policy = JSON.parse(fsSync.readFileSync(policyFile, 'utf8'));
    if (policy.ExtensionInstallBlocklist?.includes('*') && !policy.ExtensionInstallAllowlist?.length) {
      return 'La política administrada ExtensionInstallBlocklist impide instalar esta extensión en el navegador del entorno.';
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return false;
}

function page(body, title = 'Mercado Libre') {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function detail(id, description, phone) {
  return page(`
    <nav aria-label="breadcrumb" class="andes-breadcrumb">
      <ol><li>Inmuebles</li><li>Montevideo</li><li>Pocitos</li><li>Apartamentos</li></ol>
    </nav>
    <h1 class="ui-pdp-title" itemprop="name">Dueño vende apartamento ${id}</h1>
    <p class="ui-vip-location__map-address" itemprop="address">Pocitos, Montevideo</p>
    <section class="ui-pdp-description"><h2>Descripción</h2>
      <p class="ui-pdp-description__content" itemprop="description">${description}</p>
    </section>
    ${phone ? `<a href="tel:${phone}">Teléfono: ${phone}</a>` : ''}
  `);
}

test('la extensión instalada recorre resultados, excluye no inmobiliarias y pausa ante restricciones', { timeout: 90000, skip: installationRestriction() }, async () => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'abate-extension-test-'));
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: '/usr/bin/chromium',
    headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const requested = [];
  const fixtures = new Map([
    [searchUrl, page(`<h1>Dueño vende Pocitos</h1>
      <a class="poly-component__title" href="${detailUrl('1111111111')}">Dueño vende apartamento</a>
      <a class="poly-component__title" href="${detailUrl('1111111111')}?tracking_id=duplicado">Repetido</a>
      <a class="poly-component__title" href="${detailUrl('2222222222')}">Dueño vende otro apartamento</a>`) ],
    [detailUrl('1111111111'), detail('1111111111', 'Dueño directo vende apartamento. Coordinar visitas.', '+59899123456')],
    [detailUrl('2222222222'), detail('2222222222', 'Dueño vende. No inmobiliarias. Abstenerse intermediarios.', '+59899234567')],
  ]);
  await context.route('**/*', async (route) => {
    const url = route.request().url();
    if (!url.startsWith('http:') && !url.startsWith('https:')) return route.continue();
    requested.push({ method: route.request().method(), url });
    const normalized = new URL(url);
    normalized.search = '';
    normalized.hash = '';
    const html = fixtures.get(normalized.href);
    if (html) return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    return route.abort();
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const source = await context.newPage();
    await source.goto(searchUrl);
    const sourceId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({ url });
      return tabs[0]?.id;
    }, searchUrl);
    assert.equal(typeof sourceId, 'number');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html?sourceTabId=${sourceId}`);
    const start = await panel.evaluate(async (tabId) => chrome.runtime.sendMessage({
      type: 'ABATE_START', tabId, maxListings: 5, maxSearchPages: 2, revealPhone: true,
    }), sourceId);
    assert.equal(start.ok, true, JSON.stringify(start));
    await panel.waitForFunction(async () => {
      const { ABATE_STATE } = await chrome.storage.local.get('ABATE_STATE');
      return ABATE_STATE && ['done', 'error', 'paused'].includes(ABATE_STATE.phase);
    }, null, { timeout: 45000 });
    const { ABATE_STATE: state } = await worker.evaluate(() => chrome.storage.local.get('ABATE_STATE'));
    assert.equal(state.phase, 'done', JSON.stringify(state));
    assert.equal(state.records.length, 2, JSON.stringify(state));
    const candidate = state.records.find((record) => record.id.includes('1111111111'));
    const excluded = state.records.find((record) => record.id.includes('2222222222'));
    assert.ok(candidate, 'El primer aviso debe quedar registrado');
    assert.equal(candidate.pocitosStatus, 'confirmed');
    assert.equal(candidate.phone, '+59899123456');
    assert.equal(candidate.consent, 'No consta');
    assert.ok(excluded?.agencyRefusal, 'Debe reconocer rechazo a inmobiliarias');
    assert.ok(excluded.exclusionReason, 'Debe explicar la exclusión');
    assert.equal(excluded.phone, '', 'No incorpora teléfonos de avisos excluidos');
    await panel.waitForFunction(() => document.body.innerText.includes('1111111111'));
    assert.ok(requested.every((request) => request.method === 'GET'), 'El recorrido no envía formularios');
    assert.ok(requested.every((request) => new URL(request.url).hostname.endsWith('.mercadolibre.com.uy')), 'Solo consulta páginas del alcance');
    assert.equal(requested.filter((request) => request.url === detailUrl('1111111111')).length, 1, 'No vuelve a abrir el aviso duplicado');

    await panel.evaluate(() => chrome.runtime.sendMessage({ type: 'ABATE_CLEAR' }));
    const blockedUrl = 'https://listado.mercadolibre.com.uy/verificacion';
    fixtures.set(blockedUrl, page('<h1>Verificá que sos una persona</h1><p>Completá el captcha para continuar.</p>'));
    await source.goto(blockedUrl);
    const second = await panel.evaluate(async (tabId) => chrome.runtime.sendMessage({
      type: 'ABATE_START', tabId, maxListings: 5, maxSearchPages: 2,
    }), sourceId);
    assert.equal(second.ok, true);
    await panel.waitForFunction(async () => {
      const { ABATE_STATE } = await chrome.storage.local.get('ABATE_STATE');
      return ABATE_STATE?.phase === 'paused' || ABATE_STATE?.phase === 'error';
    }, null, { timeout: 30000 });
    const { ABATE_STATE: blocked } = await worker.evaluate(() => chrome.storage.local.get('ABATE_STATE'));
    assert.equal(blocked.records.length, 0, 'No inventa registros ante una verificación');
    assert.match(blocked.message, /verific|captcha|acceso|bloque|restric/i);
  } finally {
    await context.close();
    await fs.rm(profile, { recursive: true, force: true });
  }
});
