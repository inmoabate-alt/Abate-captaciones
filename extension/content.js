(function () {
  "use strict";
  if (globalThis.__abateScannerInstalled) return;
  globalThis.__abateScannerInstalled = true;

  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  function revealControl(document, parser) {
    for (const element of document.querySelectorAll("button, a[href], [role='button']")) {
      if (!parser.isVisible(element) || element.disabled || element.getAttribute("aria-disabled") === "true" || element.closest("form") || element.form || element.getAttribute("type")?.toLowerCase() === "submit") continue;
      const label = parser.normalize(parser.visibleText(element) || element.getAttribute("aria-label") || "");
      if (!/^(?:ver|mostrar) telefonos?$/.test(label)) continue;
      const href = element.getAttribute("href");
      if (href && !href.startsWith("#")) {
        let url;
        try { url = new URL(href, location.href); } catch (_) { continue; }
        if (!parser.isAllowedUrl(url.href) || url.origin !== location.origin || url.pathname !== location.pathname || /(?:login|authorization|registration|whatsapp|contactar|preguntar)/i.test(url.pathname)) continue;
      }
      return element;
    }
    return null;
  }

  async function scan(message) {
    const parser = globalThis.AbateParser;
    if (!parser) throw new Error("No está disponible el lector de la página.");
    if (message.kind === "search") return parser.extractSearch(document, location.href);
    let result = parser.extractDetail(document, location.href);
    if (message.revealPhone !== true || result.blocked || result.phone || result.agencyRefusal || result.pocitosStatus === "outside" || result.ownerStatus === "agency") return result;
    const control = revealControl(document, parser);
    if (!control) return result;
    control.click();
    for (let attempt = 0; attempt < 12; attempt++) {
      await delay(150);
      result = parser.extractDetail(document, location.href);
      if (result.blocked || result.phone) break;
    }
    return result;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || message.type !== "ABATE_SCAN" || !["search", "detail"].includes(message.kind)) return false;
    scan(message).then(sendResponse).catch(() => sendResponse({ kind: message.kind, blocked: true, blockReason: "No fue posible leer esta página. La revisión se detuvo." }));
    return true;
  });
})();
