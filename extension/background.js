/* Abate Propiedades: lectura local de avisos mediante pestañas normales. */
(() => {
  "use strict";

  const STORAGE_KEY = "ABATE_STATE";
  const PAGE_DELAY_MS = 2000;
  const LOAD_TIMEOUT_MS = 25000;
  const KNOWN_MESSAGES = new Set([
    "ABATE_GET_STATE", "ABATE_START", "ABATE_PAUSE", "ABATE_RESUME", "ABATE_CLEAR"
  ]);

  const emptyState = () => ({
    phase: "idle",
    message: "Abrí una búsqueda de dueño vende en Pocitos para comenzar.",
    searchQueue: [], detailQueue: [], seenPages: [], seenIds: [], records: [],
    searchPagesProcessed: 0, detailsProcessed: 0,
    maxListings: 25, maxSearchPages: 10, revealPhone: true,
    workerTabId: null, sourceTabId: null, currentTask: null,
    limitNote: "", startedAt: null, updatedAt: null
  });

  let state = emptyState();
  let generation = 0;
  let activeController = null;
  let activeLoop = null;
  let commandChain = Promise.resolve();
  let saveChain = Promise.resolve();

  const copy = (value) => JSON.parse(JSON.stringify(value));
  const text = (value, max = 1000) => typeof value === "string" ? value.slice(0, max) : "";

  function allowedUrl(value) {
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && !url.username && !url.password &&
        (!url.port || url.port === "443") &&
        (host === "mercadolibre.com.uy" || host.endsWith(".mercadolibre.com.uy"));
    } catch (_) { return false; }
  }

  function cleanUrl(value) {
    if (!allowedUrl(value)) throw new Error("Solo se pueden consultar páginas HTTPS de Mercado Libre Uruguay.");
    const url = new URL(value);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "tracking_id" || key === "polycard_client") {
        url.searchParams.delete(key);
      }
    }
    if (url.href.length > 4096) throw new Error("La dirección de esta página es demasiado larga. Abrí un enlace directo al aviso o a la búsqueda.");
    return url.href;
  }

  function itemId(value) {
    if (!allowedUrl(value)) return "";
    const match = new URL(value).pathname.match(/\bMLU-?(\d{6,20})\b/i);
    return match ? `MLU${match[1]}` : "";
  }

  function bounded(value, fallback, maximum, label) {
    if (value === undefined || value === null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > maximum) {
      throw new Error(`${label} debe ser un entero entre 1 y ${maximum}.`);
    }
    return number;
  }

  function save() {
    state.updatedAt = new Date().toISOString();
    const snapshot = copy(state);
    const write = saveChain.catch(() => {}).then(() => chrome.storage.local.set({ [STORAGE_KEY]: snapshot }));
    saveChain = write;
    return write;
  }

  const ready = (async () => {
    const saved = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
    if (saved && typeof saved === "object") {
      state = { ...emptyState(), ...saved };
      for (const key of ["searchQueue", "detailQueue", "seenPages", "seenIds", "records"]) {
        if (!Array.isArray(state[key])) state[key] = [];
      }
      // Los IDs de pestaña persistidos pueden pertenecer a otra pestaña tras
      // reiniciar el navegador. Nunca reutilizamos esa referencia en frío.
      const hadWorker = Number.isInteger(state.workerTabId);
      state.workerTabId = null;
      if (state.phase === "running") {
        state.phase = "paused";
        state.message = "La extensión se reinició. Continuar abrirá una nueva pestaña de consulta y retomará los avisos pendientes.";
        await save();
      } else if (hadWorker) await save();
    }
  })();

  function cancelled() {
    const error = new Error("Consulta pausada.");
    error.name = "AbortError";
    return error;
  }

  function check(token, signal) {
    if (signal.aborted || token !== generation || state.phase !== "running") throw cancelled();
  }

  function stopLoop() {
    generation += 1;
    if (activeController) activeController.abort();
    activeController = null;
  }

  function delay(milliseconds, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(cancelled());
      const timer = setTimeout(done, milliseconds);
      function done() { signal.removeEventListener("abort", abort); resolve(); }
      function abort() { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(cancelled()); }
      signal.addEventListener("abort", abort, { once: true });
    });
  }

  function waitForLoad(tabId, signal) {
    return new Promise((resolve, reject) => {
      let finished = false;
      const timer = setTimeout(() => end(new Error("La página no terminó de cargar. Revisá la pestaña antes de continuar.")), LOAD_TIMEOUT_MS);
      function end(error) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        signal.removeEventListener("abort", abort);
        error ? reject(error) : resolve();
      }
      function updated(id, change) { if (id === tabId && change.status === "complete") end(); }
      function removed(id) { if (id === tabId) end(new Error("Se cerró la pestaña de consulta.")); }
      function abort() { end(cancelled()); }
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) return end(cancelled());
      chrome.tabs.get(tabId).then((tab) => {
        if (tab.status === "complete") end();
      }).catch(() => end(new Error("La pestaña de consulta ya no está disponible.")));
    });
  }

  async function getWorker(token, signal) {
    if (Number.isInteger(state.workerTabId)) {
      try {
        const tab = await chrome.tabs.get(state.workerTabId);
        check(token, signal);
        return tab.id;
      } catch (error) {
        check(token, signal);
        state.workerTabId = null;
      }
    }
    const tab = await chrome.tabs.create({ url: "about:blank", active: false });
    if (signal.aborted || token !== generation || state.phase !== "running") {
      await chrome.tabs.remove(tab.id).catch(() => {});
      throw cancelled();
    }
    state.workerTabId = tab.id;
    await save();
    return tab.id;
  }

  async function scan(url, kind, token, signal) {
    const target = cleanUrl(url);
    const tabId = await getWorker(token, signal);
    check(token, signal);
    await chrome.tabs.update(tabId, { url: target, active: false });
    check(token, signal);
    await waitForLoad(tabId, signal);
    check(token, signal);
    const tab = await chrome.tabs.get(tabId);
    if (!allowedUrl(tab.url)) {
      throw new Error("La página redirigió fuera de Mercado Libre Uruguay. Revisá si solicita iniciar sesión o una verificación.");
    }
    if (kind === "detail" && itemId(tab.url) !== itemId(target)) {
      throw new Error("El aviso redirigió a otra página. Revisalo antes de continuar.");
    }
    await chrome.scripting.executeScript({ target: { tabId }, files: ["parser.js", "content.js"] });
    check(token, signal);
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "ABATE_SCAN", kind, revealPhone: kind === "detail" && state.revealPhone
    });
    check(token, signal);
    const result = response && response.result ? response.result : response;
    if (!result || response.ok === false || result.kind !== kind) {
      throw new Error(text(response && response.error) || "No se pudo leer esta página. Revisá que el aviso esté visible.");
    }
    if (result.blocked) {
      const error = new Error(text(result.blockReason) || "El sitio solicita una verificación o rechazó el acceso. Revisá la pestaña de consulta.");
      error.name = "SiteBlockedError";
      throw error;
    }
    return { result, pageUrl: cleanUrl(tab.url) };
  }

  function recordFrom(detail, requestedUrl, actualUrl) {
    const record = {
      id: itemId(actualUrl) || itemId(requestedUrl), url: actualUrl,
      title: text(detail.title, 400), price: text(detail.price, 120),
      locationText: text(detail.locationText, 500), description: text(detail.description, 6000),
      ownerEvidence: text(detail.ownerEvidence, 700),
      phone: text(detail.phone, 64),
      phones: Array.isArray(detail.phones) ? detail.phones.filter((p) => typeof p === "string").slice(0, 4).map((p) => text(p, 64)) : [],
      pocitosStatus: ["confirmed", "outside"].includes(detail.pocitosStatus) ? detail.pocitosStatus : "uncertain",
      ownerStatus: ["indicated", "agency"].includes(detail.ownerStatus) ? detail.ownerStatus : "uncertain",
      agencyRefusal: detail.agencyRefusal === true,
      observedAt: text(detail.observedAt, 60) || new Date().toISOString(),
      consent: "No consta", reviewStatus: "", exclusionReason: ""
    };
    if (!record.phone && record.phones.length) record.phone = record.phones[0];
    if (record.agencyRefusal) record.exclusionReason = "El aviso rechaza el contacto de inmobiliarias.";
    else if (record.pocitosStatus === "outside") record.exclusionReason = "La ubicación indicada no corresponde a Pocitos, Montevideo.";
    else if (record.ownerStatus === "agency") record.exclusionReason = "El aviso identifica una inmobiliaria.";

    if (record.exclusionReason) {
      record.phone = "";
      record.phones = [];
      record.reviewStatus = "Excluido";
    }
    else if (record.pocitosStatus !== "confirmed") record.reviewStatus = "Pendiente: confirmar ubicación";
    else if (record.ownerStatus !== "indicated") record.reviewStatus = "Pendiente: confirmar dueño directo";
    else if (!record.phone) record.reviewStatus = "Pendiente: teléfono no visible";
    else record.reviewStatus = "Candidato para revisión";
    // 500 registros de hasta 12 KB dejan margen dentro de la cuota local
    // habitual de 10 MB, incluso con descripciones Unicode extensas.
    const encoder = new TextEncoder();
    while (record.description && encoder.encode(JSON.stringify(record)).length > 12000) {
      record.description = record.description.slice(0, Math.max(0, record.description.length - 500));
      record.descriptionTruncated = true;
    }
    return record;
  }

  async function runLoop(token, signal) {
    try {
      while (true) {
        check(token, signal);
        if (state.searchQueue.length && state.searchPagesProcessed < state.maxSearchPages && state.seenIds.length < state.maxListings) {
          const url = cleanUrl(state.searchQueue[0]);
          if (state.seenPages.includes(url)) { state.searchQueue.shift(); await save(); continue; }
          state.currentTask = { kind: "search", url };
          state.message = `Leyendo búsqueda: página ${state.searchPagesProcessed + 1} de hasta ${state.maxSearchPages}.`;
          await save();
          const { result } = await scan(url, "search", token, signal);
          check(token, signal);
          state.searchQueue.shift();
          state.seenPages.push(url);
          state.searchPagesProcessed += 1;
          let omittedNewItems = false;
          for (const candidate of Array.isArray(result.itemUrls) ? result.itemUrls : []) {
            if (!allowedUrl(candidate)) continue;
            const id = itemId(candidate);
            if (!id || state.seenIds.includes(id)) continue;
            let cleanCandidate;
            try { cleanCandidate = cleanUrl(candidate); } catch (_) { continue; }
            if (state.seenIds.length >= state.maxListings) {
              omittedNewItems = true;
              continue;
            }
            state.seenIds.push(id);
            state.detailQueue.push(cleanCandidate);
          }
          if (omittedNewItems) {
            state.limitNote = `Se alcanzó el límite de ${state.maxListings} avisos; quedaron otros avisos de esta página sin revisar.`;
          }
          if (result.nextUrl && allowedUrl(result.nextUrl)) {
            const next = cleanUrl(result.nextUrl);
            if (state.seenIds.length >= state.maxListings) state.limitNote ||= `Se alcanzó el límite de ${state.maxListings} avisos de esta consulta.`;
            else if (state.searchPagesProcessed >= state.maxSearchPages) state.limitNote = `Se alcanzó el límite de ${state.maxSearchPages} páginas de búsqueda.`;
            else if (!state.seenPages.includes(next) && !state.searchQueue.includes(next)) state.searchQueue.push(next);
          }
          state.currentTask = null;
          await save();
        } else if (state.detailQueue.length && state.detailsProcessed < state.maxListings) {
          const url = cleanUrl(state.detailQueue[0]);
          const id = itemId(url);
          if (state.records.some((record) => record.id === id)) { state.detailQueue.shift(); await save(); continue; }
          state.currentTask = { kind: "detail", url };
          state.message = `Revisando aviso ${state.detailsProcessed + 1} de ${state.seenIds.length}.`;
          await save();
          const { result, pageUrl } = await scan(url, "detail", token, signal);
          check(token, signal);
          state.records.push(recordFrom(result, url, pageUrl));
          state.detailQueue.shift();
          state.detailsProcessed += 1;
          state.currentTask = null;
          await save();
        } else {
          state.phase = "done";
          state.currentTask = null;
          state.message = state.records.length
            ? `Revisión terminada: ${state.records.length} avisos registrados. ${state.limitNote} Ningún contacto está habilitado automáticamente para envío.`.trim()
            : "No se encontraron avisos para revisar en esa página. Comprobá la búsqueda y sus filtros.";
          await save();
          return;
        }
        if (state.searchQueue.length || state.detailQueue.length) await delay(PAGE_DELAY_MS, signal);
      }
    } catch (error) {
      if (signal.aborted || token !== generation || error.name === "AbortError") return;
      state.phase = error.name === "SiteBlockedError" ? "paused" : "error";
      state.message = text(error.message, 1500) || "La consulta se detuvo. Revisá la pestaña antes de continuar.";
      await save().catch(() => {});
    }
  }

  function launchLoop() {
    if (activeController) activeController.abort();
    const controller = new AbortController();
    activeController = controller;
    const token = ++generation;
    const previous = activeLoop;
    const loop = Promise.resolve(previous).catch(() => {}).then(() => runLoop(token, controller.signal));
    activeLoop = loop;
    loop.finally(() => {
      if (activeLoop === loop) activeLoop = null;
      if (activeController === controller) activeController = null;
    });
  }

  async function handle(message) {
    await ready;
    switch (message.type) {
      case "ABATE_GET_STATE": return { ok: true, state: copy(state) };
      case "ABATE_START": {
        if (state.phase === "running") throw new Error("Ya hay una consulta en curso.");
        if (state.records.length || state.seenPages.length || state.seenIds.length || state.searchQueue.length || state.detailQueue.length) {
          throw new Error("Hay una consulta guardada. Exportala y usá Limpiar antes de iniciar otra, o continuá la pendiente.");
        }
        if (!Number.isInteger(message.tabId)) throw new Error("Elegí una pestaña de Mercado Libre.");
        const source = await chrome.tabs.get(message.tabId);
        const url = cleanUrl(source.url);
        const maxListings = bounded(message.maxListings, 25, 500, "El límite de avisos");
        const maxSearchPages = bounded(message.maxSearchPages, 10, 50, "El límite de páginas");
        const previousWorker = state.workerTabId;
        state = {
          ...emptyState(), phase: "running", message: "Preparando la consulta de Pocitos…",
          sourceTabId: source.id, workerTabId: previousWorker,
          maxListings, maxSearchPages, revealPhone: message.revealPhone !== false,
          startedAt: new Date().toISOString()
        };
        if (itemId(url)) { state.detailQueue.push(url); state.seenIds.push(itemId(url)); }
        else state.searchQueue.push(url);
        await save();
        launchLoop();
        return { ok: true, state: copy(state) };
      }
      case "ABATE_PAUSE":
        if (state.phase === "running") {
          stopLoop();
          state.phase = "paused";
          state.message = "Consulta pausada. Los datos y avisos pendientes quedaron guardados.";
          await save();
        }
        return { ok: true, state: copy(state) };
      case "ABATE_RESUME":
        if (!["paused", "error"].includes(state.phase)) throw new Error("No hay una consulta pausada para continuar.");
        if (!state.searchQueue.length && !state.detailQueue.length) throw new Error("No hay avisos pendientes. Podés exportar o limpiar esta consulta.");
        state.phase = "running";
        state.message = "Retomando la consulta…";
        await save();
        launchLoop();
        return { ok: true, state: copy(state) };
      case "ABATE_CLEAR": {
        if (state.phase === "running") throw new Error("Pausá la consulta antes de limpiar los datos.");
        stopLoop();
        const worker = state.workerTabId;
        state = emptyState();
        await save();
        if (Number.isInteger(worker)) await chrome.tabs.remove(worker).catch(() => {});
        return { ok: true, state: copy(state) };
      }
      default: throw new Error("Acción desconocida.");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !KNOWN_MESSAGES.has(message.type)) return false;
    // Los controles pertenecen al panel local, no a páginas de Mercado Libre.
    const panelOrigin = chrome.runtime.getURL("");
    if (sender && ((sender.url && !sender.url.startsWith(panelOrigin)) || (sender.tab && !sender.url))) {
      sendResponse({ ok: false, error: "Los controles solo se aceptan desde el panel de la extensión." });
      return false;
    }
    const operation = commandChain.catch(() => {}).then(() => handle(message));
    commandChain = operation;
    operation.then(sendResponse, (error) => sendResponse({ ok: false, error: text(error.message, 1500) }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    ready.then(async () => {
      if (state.workerTabId !== tabId) return;
      state.workerTabId = null;
      if (state.phase === "running") {
        stopLoop();
        state.phase = "paused";
        state.message = "Se cerró la pestaña de consulta. Pulsá Continuar para abrir una nueva y retomar.";
      }
      await save();
    }).catch(() => {});
  });

  chrome.action.onClicked.addListener((tab) => {
    const suffix = Number.isInteger(tab && tab.id) ? `?sourceTabId=${tab.id}` : "";
    chrome.tabs.create({ url: chrome.runtime.getURL(`panel.html${suffix}`) }).catch(() => {});
  });
})();
