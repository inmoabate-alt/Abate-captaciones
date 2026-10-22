"use strict";

(() => {
  const SEARCH_URL = "https://listado.mercadolibre.com.uy/dueno-vende-pocitos";
  const PHASES = { idle: "En espera", running: "Revisando", paused: "Pausado", done: "Finalizado", error: "Necesita atención" };
  const COLUMN_NAMES = {
    id: "ID del aviso", url: "Enlace", title: "Título", price: "Precio", locationText: "Ubicación",
    pocitosStatus: "Revisión de ubicación", ownerStatus: "Revisión de dueño directo", ownerEvidence: "Indicios de dueño directo",
    agencyRefusal: "Rechaza inmobiliarias", phone: "Teléfono", phones: "Teléfonos encontrados", reviewStatus: "Resultado de revisión",
    exclusionReason: "Motivo de exclusión", consent: "Autorización comercial", observedAt: "Fecha de consulta", description: "Descripción",
    blocked: "Acceso bloqueado", blockReason: "Motivo del bloqueo"
  };
  const elements = Object.fromEntries([
    "source-tab", "refresh-tabs", "open-search", "start-form", "max-listings", "max-pages", "reveal-phone", "start", "pause", "resume",
    "phase-badge", "status-message", "action-error", "pages-count", "reviewed-count", "phones-count", "candidates-count",
    "export-csv", "clear-data", "results-body", "empty-state", "message-draft", "copy-message", "copy-status"
  ].map(id => [id, document.getElementById(id)]));
  const sourceParam = Number(new URL(location.href).searchParams.get("sourceTabId"));
  let preferredTabId = Number.isSafeInteger(sourceParam) && sourceParam > 0 ? sourceParam : null;
  let state = { phase: "idle", records: [] };
  let pending = false;
  let availableTabs = [];
  const formatCount = value => new Intl.NumberFormat("es-UY").format(Number(value) || 0);

  function allowedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (url.hostname === "mercadolibre.com.uy" || url.hostname.endsWith(".mercadolibre.com.uy")) && !url.username && !url.password;
    } catch { return false; }
  }

  function showError(message) {
    elements["action-error"].textContent = message || "";
    elements["action-error"].hidden = !message;
  }

  async function send(type, details = {}) {
    const result = await chrome.runtime.sendMessage({ type, ...details });
    if (!result || result.ok === false) {
      throw new Error(result?.error || result?.message || "No se pudo completar la acción. Probá nuevamente.");
    }
    if (result.state) render(result.state);
    return result;
  }

  async function perform(action) {
    if (pending) return;
    pending = true;
    showError("");
    updateButtons();
    try { await action(); }
    catch (error) { showError(error?.message || "No se pudo completar la acción."); }
    finally { pending = false; updateButtons(); }
  }

  function updateButtons() {
    const running = state.phase === "running";
    const paused = state.phase === "paused";
    const resumableError = state.phase === "error" && ((state.searchQueue?.length || 0) + (state.detailQueue?.length || 0) > 0);
    const resumable = paused || resumableError;
    const records = Array.isArray(state.records) ? state.records : [];
    elements.start.disabled = pending || running || resumable || records.length > 0 || !elements["source-tab"].value;
    elements.pause.disabled = pending || !running;
    elements.resume.disabled = pending || !resumable;
    elements["clear-data"].disabled = pending || running || (!records.length && state.phase === "idle");
    elements["export-csv"].disabled = records.length === 0;
    elements["source-tab"].disabled = pending || running || resumable;
    elements["refresh-tabs"].disabled = pending || running || resumable;
    elements["max-listings"].disabled = pending || running || resumable;
    elements["max-pages"].disabled = pending || running || resumable;
    elements["reveal-phone"].disabled = pending || running || resumable;
  }

  function recordResult(record) {
    if (record.agencyRefusal) return { label: "Excluido: no inmobiliarias", tone: "excluded" };
    if (record.pocitosStatus === "outside") return { label: "Excluido: fuera de Pocitos", tone: "excluded" };
    if (record.ownerStatus === "agency") return { label: "Excluido: inmobiliaria", tone: "excluded" };
    if (record.exclusionReason) return { label: record.reviewStatus || "Excluido", tone: "excluded" };
    if (record.pocitosStatus !== "confirmed") return { label: "Ubicación por revisar", tone: "pending" };
    if (record.ownerStatus !== "indicated") return { label: "Dueño directo por revisar", tone: "pending" };
    if (!record.phone && !record.phones?.length) return { label: "Teléfono pendiente", tone: "pending" };
    return { label: "Candidato para revisar", tone: "candidate" };
  }

  function cell(text, className) {
    const td = document.createElement("td");
    td.textContent = text;
    if (className) td.className = className;
    return td;
  }

  function render(nextState) {
    state = nextState && typeof nextState === "object" ? nextState : { phase: "idle", records: [] };
    const records = Array.isArray(state.records) ? state.records : [];
    if (["running", "paused", "error"].includes(state.phase)) {
      if (Number.isInteger(state.maxListings)) elements["max-listings"].value = String(state.maxListings);
      if (Number.isInteger(state.maxSearchPages)) elements["max-pages"].value = String(state.maxSearchPages);
      if (typeof state.revealPhone === "boolean") elements["reveal-phone"].checked = state.revealPhone;
    }
    const badge = elements["phase-badge"];
    badge.textContent = PHASES[state.phase] || "En espera";
    badge.dataset.phase = state.phase || "idle";
    elements["status-message"].textContent = state.message || "Elegí una pestaña para empezar.";
    elements["pages-count"].textContent = formatCount(state.searchPagesProcessed);
    elements["reviewed-count"].textContent = formatCount(state.detailsProcessed ?? records.length);
    elements["phones-count"].textContent = formatCount(records.filter(record => record.phone || record.phones?.length).length);
    elements["candidates-count"].textContent = formatCount(records.filter(record => recordResult(record).tone === "candidate").length);
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const row = document.createElement("tr");
      const property = cell("");
      const title = document.createElement("span");
      title.className = "property-title";
      title.textContent = record.title || "Aviso sin título disponible";
      const meta = document.createElement("span");
      meta.className = "property-meta";
      meta.textContent = [record.id, record.price].filter(Boolean).join(" · ");
      property.append(title, meta);
      row.append(property, cell(record.locationText || "Ubicación pendiente"), cell(record.phone || (Array.isArray(record.phones) ? record.phones.join(" · ") : "") || "Pendiente"));
      const statusCell = cell("");
      const result = recordResult(record);
      const tag = document.createElement("span");
      tag.className = "record-status";
      tag.dataset.tone = result.tone;
      tag.textContent = result.label;
      statusCell.append(tag);
      if (record.exclusionReason) {
        const note = document.createElement("div");
        note.className = "record-note";
        note.textContent = record.exclusionReason;
        statusCell.append(note);
      }
      row.append(statusCell);
      const linkCell = cell("");
      if (allowedUrl(record.url)) {
        const link = document.createElement("a");
        link.href = record.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "property-link";
        link.textContent = "Ver aviso ↗";
        link.setAttribute("aria-label", `Ver aviso: ${record.title || record.id || "propiedad"}`);
        linkCell.append(link);
      }
      row.append(linkCell);
      fragment.append(row);
    }
    elements["results-body"].replaceChildren(fragment);
    elements["empty-state"].hidden = records.length > 0;
    updateButtons();
  }

  async function refreshTabs() {
    const previouslySelected = Number(elements["source-tab"].value) || preferredTabId;
    const tabs = await chrome.tabs.query({});
    availableTabs = tabs.filter(tab => Number.isSafeInteger(tab.id) && tab.id !== state.workerTabId && allowedUrl(tab.url));
    const fragment = document.createDocumentFragment();
    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = availableTabs.length ? "Elegí una pestaña de Mercado Libre" : "No hay pestañas de Mercado Libre abiertas";
    fragment.append(prompt);
    for (const tab of availableTabs) {
      const option = document.createElement("option");
      option.value = String(tab.id);
      const label = tab.title || new URL(tab.url).hostname;
      option.textContent = label.length > 105 ? label.slice(0, 102) + "…" : label;
      fragment.append(option);
    }
    elements["source-tab"].replaceChildren(fragment);
    const selected = availableTabs.find(tab => tab.id === previouslySelected) || availableTabs.find(tab => tab.active) || availableTabs[0];
    if (selected) elements["source-tab"].value = String(selected.id);
    preferredTabId = selected?.id || null;
    updateButtons();
  }

  function valueText(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(valueText).join(" | ");
    if (typeof value === "object") return JSON.stringify(value);
    if (typeof value === "boolean") return value ? "Sí" : "No";
    return String(value);
  }

  function csvCell(value, forceText = false) {
    let text = valueText(value);
    if (text && (forceText || /^[\t\r\n]/.test(text) || /^[\s\u0000-\u001f]*[=+\-@]/.test(text))) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  function makeCsv(records) {
    const keys = Object.keys(COLUMN_NAMES);
    const extraKeys = [...new Set(records.flatMap(record => Object.keys(record)))].filter(key => !keys.includes(key)).sort();
    const allKeys = [...keys, ...extraKeys];
    const lines = [allKeys.map(key => csvCell(COLUMN_NAMES[key] || key)).join(";")];
    for (const record of records) {
      lines.push(allKeys.map(key => csvCell(key === "consent" ? record[key] || "No consta" : record[key], key === "phone" || key === "phones")).join(";"));
    }
    return "\uFEFF" + lines.join("\r\n") + "\r\n";
  }

  function downloadCsv() {
    const records = Array.isArray(state.records) ? state.records : [];
    if (!records.length) return;
    const blobUrl = URL.createObjectURL(new Blob([makeCsv(records)], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Montevideo", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date());
    const part = type => dateParts.find(item => item.type === type)?.value || "";
    link.href = blobUrl;
    link.download = `abate-pocitos-${part("year")}-${part("month")}-${part("day")}.csv`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1500);
  }

  elements["start-form"].addEventListener("submit", event => {
    event.preventDefault();
    if (!elements["start-form"].reportValidity()) return;
    void perform(async () => {
      const tabId = Number(elements["source-tab"].value);
      const selected = availableTabs.find(tab => tab.id === tabId);
      if (!selected || !allowedUrl(selected.url)) throw new Error("Elegí una pestaña de Mercado Libre para empezar.");
      const current = await chrome.tabs.get(tabId);
      if (!allowedUrl(current.url)) throw new Error("Esa pestaña ya no está en Mercado Libre. Actualizá la lista y elegí otra.");
      const maxListings = Number(elements["max-listings"].value);
      const maxSearchPages = Number(elements["max-pages"].value);
      if (!Number.isInteger(maxListings) || maxListings < 1 || maxListings > 500 || !Number.isInteger(maxSearchPages) || maxSearchPages < 1 || maxSearchPages > 50) throw new Error("Elegí entre 1 y 500 avisos y entre 1 y 50 páginas.");
      await send("ABATE_START", { tabId, maxListings, maxSearchPages, revealPhone: elements["reveal-phone"].checked });
    });
  });
  elements["source-tab"].addEventListener("change", updateButtons);
  elements["refresh-tabs"].addEventListener("click", () => void perform(refreshTabs));
  elements["open-search"].addEventListener("click", () => void perform(async () => {
    const tab = await chrome.tabs.create({ url: SEARCH_URL, active: true });
    preferredTabId = tab.id;
  }));
  elements.pause.addEventListener("click", () => void perform(() => send("ABATE_PAUSE")));
  elements.resume.addEventListener("click", () => void perform(() => send("ABATE_RESUME")));
  elements["clear-data"].addEventListener("click", () => void perform(async () => {
    const count = Array.isArray(state.records) ? state.records.length : 0;
    if (count && !window.confirm(`¿Querés borrar los ${count} avisos guardados en este navegador? Descargá el CSV primero si querés conservarlos.`)) return;
    await send("ABATE_CLEAR");
    await refreshTabs();
  }));
  elements["export-csv"].addEventListener("click", downloadCsv);
  elements["copy-message"].addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements["message-draft"].textContent.trim());
      elements["copy-status"].textContent = "Borrador copiado.";
    } catch {
      elements["copy-status"].textContent = "No se pudo copiar automáticamente. Podés seleccionar y copiar el texto.";
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.ABATE_STATE) render(changes.ABATE_STATE.newValue);
  });
  chrome.tabs.onRemoved.addListener(() => void refreshTabs().catch(() => {}));
  chrome.tabs.onUpdated.addListener((_id, change) => {
    if (change.status === "complete" && state.phase !== "running") void refreshTabs().catch(() => {});
  });
  void perform(async () => {
    const stored = await chrome.storage.local.get("ABATE_STATE");
    if (stored.ABATE_STATE) render(stored.ABATE_STATE);
    await send("ABATE_GET_STATE");
    await refreshTabs();
  });
})();
