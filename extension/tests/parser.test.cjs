const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const searchUrl = 'https://listado.mercadolibre.com.uy/dueno-vende-pocitos';
const itemUrl = 'https://casa.mercadolibre.com.uy/MLU-1522912746-dueno-vende-_JM';
let browser;

before(async () => { browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true }); });
after(async () => { await browser?.close(); });

async function fixture(html, fn) {
  const page = await browser.newPage();
  await page.route('**/*', route => route.request().url() === itemUrl ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html }) : route.abort());
  await page.goto(itemUrl);
  await page.addScriptTag({ path: path.join(root, 'parser.js') });
  try { return await fn(page); } finally { await page.close(); }
}

async function detail(html) {
  return fixture(html, page => page.evaluate(url => AbateParser.extractDetail(document, url), itemUrl));
}

const location = '<nav class="andes-breadcrumb">Inmuebles > Venta > Montevideo > Pocitos</nav>';

test('normaliza texto y acepta exclusivamente hosts HTTPS legítimos de Uruguay', async () => {
  const result = await fixture('<p>Prueba</p>', page => page.evaluate(() => ({
    normalized: AbateParser.normalize('  DUEÑO\n VENDE  '),
    allowed: ['https://mercadolibre.com.uy/a', 'https://casa.mercadolibre.com.uy/a'].map(AbateParser.isAllowedUrl),
    denied: ['http://mercadolibre.com.uy/a', 'https://mercadolibre.com.uy.evil.example/a', 'https://evilmercadolibre.com.uy/a', 'https://usuario@mercadolibre.com.uy/a', 'https://mercadolibre.com.uy:444/a'].map(AbateParser.isAllowedUrl),
  })));
  assert.equal(result.normalized, 'dueno vende');
  assert.deepEqual(result.allowed, [true, true]);
  assert.deepEqual(result.denied, [false, false, false, false, false]);
});

test('deduplica avisos por ID, omite links ocultos y encuentra siguiente página', async () => {
  const result = await fixture(`
    <header><a href="https://www.mercadolibre.com.uy/login">Ingresá</a></header>
    <a href="${itemUrl}?tracking=1">Casa</a>
    <a href="https://casa.mercadolibre.com.uy/MLU1522912746-otro-_JM#foto">Duplicado</a>
    <a hidden href="https://casa.mercadolibre.com.uy/MLU-99999999-oculto-_JM">Oculto</a>
    <a href="https://casa.mercadolibre.com.uy.evil.example/MLU-88888888-no-_JM">Ajeno</a>
    <a rel="next" href="${searchUrl}_Desde_49?orden=reciente">Siguiente</a>`,
    page => page.evaluate(url => AbateParser.extractSearch(document, url), searchUrl));
  assert.equal(result.blocked, false);
  assert.deepEqual(result.itemUrls, [itemUrl]);
  assert.equal(result.nextUrl, searchUrl + '_Desde_49?orden=reciente');
});

test('rechaza paginación a otro host, incluso un host de Mercado Libre', async () => {
  const result = await fixture('<a rel="next" href="https://casa.mercadolibre.com.uy/otra-busqueda">Siguiente</a>', page => page.evaluate(url => AbateParser.extractSearch(document, url), searchUrl));
  assert.equal(result.nextUrl, '');
});

test('extrae ubicación estructurada, evidencia de dueño y teléfono visible', async () => {
  const result = await detail(`${location}<h1>Dueño vende casa</h1><div data-testid="price">USD 250.000</div><div data-testid="description">Casa luminosa.</div><a href="tel:099123456">099 123 456</a>`);
  assert.equal(result.id, 'MLU1522912746');
  assert.equal(result.pocitosStatus, 'confirmed');
  assert.equal(result.ownerStatus, 'indicated');
  assert.equal(result.agencyRefusal, false);
  assert.equal(result.phone, '+59899123456');
});

test('mencionar Pocitos en la descripción no acredita ubicación', async () => {
  const result = await detail('<h1>Dueño vende</h1><div data-testid="description">A pocos minutos de Pocitos y de todo Montevideo.</div>');
  assert.equal(result.pocitosStatus, 'uncertain');
});

test('Pocitos Nuevo queda fuera y ubicación parcial no se completa', async () => {
  const outside = await detail('<div data-testid="location">Pocitos Nuevo, Montevideo</div><h1>Casa</h1>');
  const partial = await detail('<div data-testid="location">Pocitos</div><h1>Casa</h1>');
  const other = await detail('<div data-testid="location">Cordón, Montevideo</div><h1>Casa</h1>');
  assert.equal(outside.pocitosStatus, 'outside');
  assert.equal(partial.pocitosStatus, 'uncertain');
  assert.equal(other.pocitosStatus, 'outside');
});

test('ubicación explícita fuera de Pocitos prevalece sobre un breadcrumb contradictorio', async () => {
  const result = await detail(`${location}<h1>Casa</h1><div data-testid="location">Cordón, Montevideo</div>`);
  assert.equal(result.pocitosStatus, 'outside');
});

test('una dirección sin barrio no contradice el breadcrumb ni se considera fuera por inferencia', async () => {
  const result = await detail(`${location}<h1>Casa</h1><div class="ui-vip-location__map-address">26 de Marzo 1234, Montevideo</div>`);
  assert.equal(result.pocitosStatus, 'confirmed');
  const partial = await detail('<h1>Casa</h1><div data-testid="location">26 de Marzo 1234, Montevideo</div>');
  assert.equal(partial.pocitosStatus, 'uncertain');
});

test('lee solo teléfonos visibles y deduplica formatos nacionales e internacionales', async () => {
  const result = await detail(`${location}<h1>Dueño vende</h1>
    <a href="tel:+59899123456">Llamar</a><p>Celular: 099 123 456</p><p>Teléfono: 00598 99 123 456</p>
    <div hidden><a href="tel:098111111">098111111</a></div>
    <div aria-hidden="true"><a href="tel:098222222">098222222</a></div>
    <a style="display:none" href="tel:098333333">098333333</a>
    <input type="hidden" value="098444444"><a href="tel:+5491123456789">Otro país</a>
    <div data-testid="price">Precio: 24987654</div><p>24999999</p>`);
  assert.deepEqual(result.phones, ['+59899123456']);
});

test('ignora números aria-hidden dentro de un bloque de contacto visible y tel malformado', async () => {
  const result = await detail(`${location}<h1>Casa</h1><p>Teléfono: <span aria-hidden="true">098 111 111</span></p><a href="tel:09%ZZ">Número inválido</a>`);
  assert.equal(result.phone, '');
  assert.deepEqual(result.phones, []);
});

test('botón Ver teléfono sin número no se interpreta como contacto', async () => {
  const result = await detail(`${location}<h1>Casa</h1><button>Ver teléfono</button>`);
  assert.equal(result.phone, '');
});

test('no inventa dueño directo a partir de negación ni marca comisión como rechazo', async () => {
  const result = await detail(`${location}<h1>Venta de casa</h1><div data-testid="description">No es venta de dueño directo. Sin comisión inmobiliaria.</div>`);
  assert.equal(result.ownerStatus, 'uncertain');
  assert.equal(result.agencyRefusal, false);
  const agency = await detail(`${location}<h1>Dueño vende</h1><div data-testid="seller-name">Ejemplo Propiedades</div>`);
  assert.equal(agency.ownerStatus, 'agency');
});

test('detecta rechazos explícitos de intermediarios', async () => {
  const result = await detail(`${location}<h1>Dueño vende</h1><div data-testid="description">No acepto intermediarios.</div>`);
  assert.equal(result.agencyRefusal, true);
});

test('respeta rechazos en el título y la variante no se aceptan inmobiliarias', async () => {
  const titleRefusal = await detail(`${location}<h1>Dueño vende, no inmobiliarias</h1><a href="tel:099123456">099123456</a>`);
  const passiveRefusal = await detail(`${location}<h1>Casa</h1><div data-testid="description">No se aceptan inmobiliarias.</div><a href="tel:099123456">099123456</a>`);
  assert.equal(titleRefusal.agencyRefusal, true);
  assert.equal(titleRefusal.phone, '');
  assert.equal(passiveRefusal.agencyRefusal, true);
  assert.equal(passiveRefusal.phone, '');
});

test('no incorpora teléfonos de avisos excluidos aunque estén visibles', async () => {
  for (const html of [
    `${location}<h1>Dueño vende</h1><div data-testid="description">No inmobiliarias.</div>`,
    '<h1>Dueño vende</h1><div data-testid="location">Pocitos Nuevo, Montevideo</div>',
    `${location}<h1>Dueño vende</h1><div data-testid="seller-name">Ejemplo Inmobiliaria</div>`,
  ]) {
    const result = await detail(html + '<a href="tel:099123456">099 123 456</a>');
    assert.equal(result.phone, '');
    assert.deepEqual(result.phones, []);
  }
});

test('bloquea verificación, login y denegación sin extraer contactos', async () => {
  for (const heading of ['Verificá que sos humano', 'Iniciá sesión', 'Acceso denegado']) {
    const result = await detail(`<h1>${heading}</h1><a href="tel:099123456">099123456</a>`);
    assert.equal(result.blocked, true, heading);
    assert.equal(result.phone, '');
  }
});

async function contentFixture(html, revealPhone) {
  return fixture(html, async page => {
    await page.evaluate(() => { globalThis.chrome = { runtime: { onMessage: { addListener(listener) { globalThis.testListener = listener; } } } }; });
    await page.addScriptTag({ path: path.join(root, 'content.js') });
    return page.evaluate(reveal => new Promise(resolve => testListener({ type: 'ABATE_SCAN', kind: 'detail', revealPhone: reveal }, {}, resolve)), revealPhone);
  });
}

test('contenido sin opt-in no pulsa Ver teléfono', async () => {
  const result = await contentFixture('<h1>Casa</h1><button onclick="document.body.insertAdjacentHTML(\'beforeend\',\'<a href=tel:099123456>099123456</a>\')">Ver teléfono</button>', false);
  assert.equal(result.phone, '');
});

test('contenido no pulsa Contactar, Enviar ni WhatsApp aunque revealPhone esté activo', async () => {
  const result = await contentFixture('<h1>Casa</h1><button onclick="document.body.innerHTML=\'NO\'">Contactar</button><button>Enviar</button><a href="https://wa.me/59899123456">WhatsApp</a>', true);
  assert.equal(result.phone, '');
});

test('opt-in pulsa solamente Ver teléfono y vuelve a leer el número visible', async () => {
  const result = await contentFixture(`${location}<h1>Dueño vende</h1><button onclick="document.body.insertAdjacentHTML('beforeend','<a href=tel:099123456>099 123 456</a>')">Ver teléfono</button>`, true);
  assert.equal(result.phone, '+59899123456');
  assert.equal(result.pocitosStatus, 'confirmed');
});

test('un enlace hacia WhatsApp con etiqueta Ver teléfono no se pulsa', async () => {
  const result = await contentFixture('<h1>Casa</h1><a href="https://wa.me/59899123456" onclick="document.body.innerHTML=\'CONTACTO\'">Ver teléfono</a>', true);
  assert.equal(result.phone, '');
  assert.equal(result.title, 'Casa');
});

test('contenido no revela teléfonos de un aviso que rechaza inmobiliarias', async () => {
  const result = await contentFixture(`${location}<h1>Dueño vende</h1><div data-testid="description">No inmobiliarias</div><button onclick="document.querySelector('h1').innerText='PULSADO'">Ver teléfono</button>`, true);
  assert.equal(result.title, 'Dueño vende');
  assert.equal(result.agencyRefusal, true);
  assert.equal(result.phone, '');
});

test('no pulsa un control Ver teléfono dentro de un formulario', async () => {
  const result = await contentFixture(`${location}<h1>Casa</h1><form><button onclick="document.querySelector('h1').innerText='PULSADO';return false">Ver teléfono</button></form>`, true);
  assert.equal(result.title, 'Casa');
  assert.equal(result.phone, '');
});

test('no sigue un enlace Ver teléfono a una ruta diferente', async () => {
  const result = await contentFixture(`${location}<h1>Casa</h1><a href="/otra-ruta" onclick="document.querySelector('h1').innerText='PULSADO';return false">Ver teléfono</a>`, true);
  assert.equal(result.title, 'Casa');
  assert.equal(result.phone, '');
});

test('no pulsa botón asociado a un formulario externo ni submit explícito', async () => {
  const result = await contentFixture(`${location}<h1>Casa</h1><form id="externo"></form><button form="externo" onclick="document.querySelector('h1').innerText='PULSADO';return false">Ver teléfono</button><button type="submit" onclick="document.querySelector('h1').innerText='PULSADO';return false">Mostrar teléfono</button>`, true);
  assert.equal(result.title, 'Casa');
  assert.equal(result.phone, '');
});
