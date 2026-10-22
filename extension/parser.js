(function () {
  "use strict";

  function normalize(value) {
    return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  function isAllowedUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443") &&
        (url.hostname === "mercadolibre.com.uy" || url.hostname.endsWith(".mercadolibre.com.uy"));
    } catch (_) { return false; }
  }

  function itemId(value) {
    if (!isAllowedUrl(value)) return "";
    const match = new URL(value).pathname.match(/(?:^|\/)(MLU-?\d{6,})(?=[-_/]|$)/i);
    return match ? match[1].replace("-", "").toUpperCase() : "";
  }

  function visible(element) {
    if (!element || element.nodeType !== 1 || element.closest("[hidden], [aria-hidden='true'], script, style, noscript, template")) return false;
    const view = element.ownerDocument.defaultView;
    if (!view) return false;
    let parent = element;
    while (parent && parent.nodeType === 1) {
      const style = view.getComputedStyle(parent);
      if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || style.opacity === "0") return false;
      parent = parent.parentElement;
    }
    return element.getClientRects().length > 0;
  }

  function text(element) {
    if (!visible(element)) return "";
    const values = [];
    const walker = element.ownerDocument.createTreeWalker(element, 4);
    let node;
    while ((node = walker.nextNode())) {
      if (visible(node.parentElement)) values.push(node.nodeValue || "");
    }
    return values.join(" ").replace(/\s+/g, " ").trim();
  }

  function firstText(document, selectors) {
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const value = text(element);
        if (value) return value;
      }
    }
    return "";
  }

  function canonical(value, base) {
    try {
      const url = new URL(value, base);
      if (!isAllowedUrl(url.href)) return "";
      url.search = "";
      url.hash = "";
      return url.href;
    } catch (_) { return ""; }
  }

  function blockReason(document, pageUrl) {
    if (!isAllowedUrl(pageUrl)) return "La página está fuera de Mercado Libre Uruguay.";
    const url = new URL(pageUrl);
    if (/(?:^|[/.])(?:auth|login|registration)(?:[/.]|$)/i.test(url.hostname + url.pathname) || /\/authorization(?:\/|$)/i.test(url.pathname)) {
      return "Mercado Libre requiere iniciar sesión. Completá ese paso personalmente antes de continuar.";
    }
    const headingText = Array.from(document.querySelectorAll("h1, h2, [role='heading']")).filter(visible).map(text).join(" ");
    const normalizedHeadings = normalize(headingText);
    const denied = /\b(acceso denegado|access denied|forbidden|demasiadas solicitudes|too many requests|hubo un error accediendo|no pudimos acceder a esta pagina)\b/;
    if (denied.test(normalizedHeadings)) return "Mercado Libre rechazó la consulta. La revisión se detuvo.";
    const challenge = /\b(captcha|verifica (?:tu identidad|que (?:sos|eres)|que no)|verifica(?:cion|r) de seguridad|security verification|comprueba que|no (?:soy|eres|sos) un robot|confirma que (?:sos|eres))\b/;
    if (challenge.test(normalizedHeadings)) return "La página requiere una verificación. Resolvela personalmente; la extensión no la completa.";
    if (/\b(inicia(?:r)? sesion|ingresa (?:a tu cuenta|para continuar|tu (?:e-?mail|correo|telefono|usuario))|identificate para continuar)\b/.test(normalizedHeadings)) {
      return "La página requiere iniciar sesión. Completá ese paso personalmente antes de continuar.";
    }
    const bodyText = normalize(text(document.body));
    if (bodyText.length < 1800 && denied.test(bodyText)) return "Mercado Libre rechazó la consulta. La revisión se detuvo.";
    for (const element of document.querySelectorAll("iframe[src*='captcha'], iframe[src*='challenge'], input[name*='captcha'], #captcha, .captcha")) {
      if (!visible(element)) continue;
      const rect = element.getBoundingClientRect();
      if (element.tagName !== "IFRAME" || (rect.width > 150 && rect.height > 100)) return "La página requiere una verificación. La revisión se detuvo.";
    }
    const password = Array.from(document.querySelectorAll("input[type='password']")).find(visible);
    if (password && !document.querySelector("h1.ui-pdp-title, h1.ui-vip-title, .poly-card, .ui-search-layout")) return "La página requiere iniciar sesión. Completá ese paso personalmente antes de continuar.";
    return "";
  }

  function extractSearch(document, pageUrl) {
    const reason = blockReason(document, pageUrl);
    const result = { kind: "search", pageUrl, blocked: Boolean(reason), blockReason: reason, itemUrls: [], nextUrl: "" };
    if (reason) return result;
    const seen = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      if (!visible(anchor)) continue;
      const url = canonical(anchor.getAttribute("href"), pageUrl);
      const id = itemId(url);
      if (id && !seen.has(id)) {
        seen.add(id);
        result.itemUrls.push(url);
      }
    }
    const base = new URL(pageUrl);
    const candidates = Array.from(document.querySelectorAll("a[rel~='next'], .andes-pagination__button--next a, a[aria-label], a[title], a.andes-pagination__link"));
    for (const anchor of candidates) {
      if (!visible(anchor) || anchor.closest("[aria-disabled='true'], .andes-pagination__button--disabled")) continue;
      const label = normalize(anchor.getAttribute("aria-label") || anchor.getAttribute("title") || text(anchor));
      const explicitlyNext = (anchor.getAttribute("rel") || "").split(/\s+/).includes("next") || anchor.closest(".andes-pagination__button--next") || /^(?:pagina )?siguiente(?: pagina)?$/.test(label);
      if (!explicitlyNext) continue;
      let url;
      try { url = new URL(anchor.getAttribute("href"), pageUrl); } catch (_) { continue; }
      if (isAllowedUrl(url.href) && url.hostname === base.hostname && !itemId(url.href) && url.href !== pageUrl && !/(?:login|authorization|registration)/i.test(url.pathname)) {
        url.hash = "";
        result.nextUrl = url.href;
        break;
      }
    }
    return result;
  }

  function sectionAfterHeading(document, label) {
    for (const heading of document.querySelectorAll("h2, h3, [role='heading']")) {
      if (!visible(heading) || !label.test(normalize(text(heading)))) continue;
      const section = heading.closest("section") || heading.parentElement;
      const value = text(section);
      if (value && value.length <= 12000) return value;
    }
    return "";
  }

  function location(document) {
    const values = [];
    const explicit = [];
    const selectors = ["[data-testid='property-location']", "[data-testid='location']", ".ui-vip-location__subtitle", ".ui-vip-location__address", ".ui-vip-location__map-address", ".ui-vip-location__main", ".ui-pdp-location__subtitle", ".ui-pdp-location__address", ".andes-breadcrumb", ".ui-pdp-breadcrumb", "nav[aria-label*='breadcrumb' i]"];
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        const value = text(element);
        if (value && value.length <= 1800) {
          if (!values.includes(value)) values.push(value);
          if (!selector.includes("breadcrumb") && !explicit.includes(value)) explicit.push(value);
        }
      }
    }
    const section = sectionAfterHeading(document, /^(?:ubicacion|ubicacion de la propiedad|donde esta ubicad[oa])$/);
    if (section && section.length <= 1800) {
      if (!values.includes(section)) values.unshift(section);
      explicit.unshift(section);
    }
    const locationText = values.join(" | ").slice(0, 4000);
    const normalized = normalize(locationText);
    function namedOutside(value) {
      const remaining = normalize(value).replace(/\b(?:uruguay|montevideo|inmuebles|venta|ventas|casa|casas|apartamento|apartamentos|terreno|terrenos|local|locales|inicio|ubicacion|direccion|barrio)\b/g, " ").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
      return /^(?:cordon|centro|punta carretas|buceo|malvin|parque rodo|parque batlle|carrasco|la blanqueada|tres cruces|la comercial|union|la union|aguada|prado|jacinto vera|reducto|capurro|bella vista|paso molino|belvedere|cerro|colon|penarol|sayago|maronas|villa espanola|punta gorda|palermo|sur|ciudad vieja|atahualpa|maldonado|punta del este)$/.test(remaining);
    }
    const explicitOutside = explicit.some(namedOutside);
    const anyOutside = values.some(namedOutside);
    let status = "uncertain";
    if (/\bpocitos nuevo\b/.test(normalized)) status = "outside";
    else if (explicitOutside) status = "outside";
    else if (anyOutside && /\bpocitos\b/.test(normalized)) status = "uncertain";
    else if (/\bpocitos\b/.test(normalized) && /\bmontevideo\b/.test(normalized)) status = "confirmed";
    else if (anyOutside) status = "outside";
    return { locationText, pocitosStatus: status };
  }

  function normalizePhone(value) {
    const original = String(value || "").trim();
    if (/[^\d\s()+.\-/]/.test(original)) return "";
    let digits = original.replace(/\D/g, "");
    if (digits.startsWith("00598")) digits = digits.slice(2);
    if (digits.startsWith("598") && digits.length === 11) digits = digits.slice(3);
    else if (original.startsWith("+") || digits.startsWith("00")) return "";
    if (digits.length === 9 && digits.startsWith("09")) digits = digits.slice(1);
    if (digits.length !== 8 || !/^[249]\d{7}$/.test(digits)) return "";
    return "+598" + digits;
  }

  function phones(document) {
    const values = new Set();
    for (const anchor of document.querySelectorAll("a[href^='tel:' i]")) {
      if (!visible(anchor)) continue;
      let decoded;
      try { decoded = decodeURIComponent(anchor.getAttribute("href").slice(4)); } catch (_) { continue; }
      const value = normalizePhone(decoded.split(/[?;]/)[0]);
      if (value) values.add(value);
    }
    const selectors = ["[data-testid='phone']", "[data-testid='seller-phone']", ".ui-vip-seller-contact__phone", ".ui-pdp-seller__phone", ".seller-contact__phone", "[class*='phone-number']", "[class*='phone_number']"];
    const blocks = new Set();
    for (const selector of selectors) for (const element of document.querySelectorAll(selector)) if (visible(element)) blocks.add(element);
    for (const element of document.querySelectorAll("p, li, dt, dd, span, div")) {
      if (!visible(element) || element.children.length > 3) continue;
      const value = text(element);
      if (value.length <= 200 && /^(?:telefono|celular|whatsapp|tel\.?)(?: de contacto)?\s*[:\-]?\s*(?:\+|\d|\()/i.test(normalize(value))) blocks.add(element);
    }
    for (const element of blocks) {
      const value = text(element);
      if (value.length > 300) continue;
      const matches = value.match(/(?:\+?598|00598)[\s().-]*[249](?:[\s().-]*\d){7}|0?9(?:[\s().-]*\d){7}|[24](?:[\s().-]*\d){7}/g) || [];
      for (const candidate of matches) {
        const phone = normalizePhone(candidate);
        if (phone) values.add(phone);
      }
    }
    return Array.from(values);
  }

  function extractDetail(document, pageUrl) {
    const reason = blockReason(document, pageUrl);
    const result = { kind: "detail", id: itemId(pageUrl), url: canonical(pageUrl, pageUrl) || pageUrl, title: "", price: "", locationText: "", description: "", ownerEvidence: "", phone: "", phones: [], pocitosStatus: "uncertain", ownerStatus: "uncertain", agencyRefusal: false, blocked: Boolean(reason), blockReason: reason, observedAt: new Date().toISOString() };
    if (reason) return result;
    result.title = firstText(document, ["h1.ui-pdp-title", "h1.ui-vip-title", "h1"] ).slice(0, 700);
    result.price = firstText(document, [".ui-pdp-price__second-line", ".ui-pdp-price__main-container", ".ui-vip-price", "[data-testid='price']", ".andes-money-amount"] ).slice(0, 300);
    result.description = (firstText(document, [".ui-pdp-description__content", ".ui-vip-description__content", ".ui-vip-description__description", "[data-testid='description']"]) || sectionAfterHeading(document, /^descripcion(?: de la propiedad)?$/)).slice(0, 12000);
    Object.assign(result, location(document));
    const normalizedDescription = normalize(result.title + " " + result.description);
    result.agencyRefusal = /\b(?:no\s+(?:(?:(?:se\s+)?(?:acepto|acepta|aceptan|aceptamos|admito|admite|admiten|admitimos)|quiero|queremos|contactar|llamar|trabaj(?:o|amos|an|a)\s+con)\s+)?(?:a\s+|con\s+)?(?:inmobiliarias?|intermediarios?)|(?:abstenerse|abstenganse)\s+(?:las\s+)?(?:inmobiliarias?|intermediarios?)|(?:inmobiliarias?|intermediarios?)\s+abstenerse)\b/.test(normalizedDescription);
    const sellerName = firstText(document, ["[data-testid='seller-name']", ".ui-vip-profile-info__info-link", ".ui-pdp-seller__header__title", ".ui-pdp-seller__link-trigger"]);
    const normalizedSeller = normalize(sellerName);
    if (/\b(?:inmobiliaria|propiedades|real estate|re\/?max|negocios inmobiliarios)\b/.test(normalizedSeller)) {
      result.ownerStatus = "agency";
      result.ownerEvidence = sellerName.slice(0, 400);
    } else {
      const source = normalize(result.title + " " + result.description);
      const negated = /\b(?:no es|no somos|no se trata de|buscamos|busc[aá]s|trabajamos con|captamos)\b[^.!?]{0,60}\b(?:dueno|particular|sin intermediarios)/.test(source);
      const match = !negated && source.match(/\b(?:duen[oa](?:\s+(?:vende|direct[oa]|alquila))|venta\s+(?:directa\s+)?(?:de|por)\s+(?:su\s+)?duen[oa]|venta\s+particular|vende\s+particular|sin\s+intermediarios)\b/);
      if (match || /^(?:vendedor:?\s*)?particular$/.test(normalizedSeller)) {
        result.ownerStatus = "indicated";
        result.ownerEvidence = match ? match[0] : sellerName;
      }
    }
    if (result.agencyRefusal || result.pocitosStatus === "outside" || result.ownerStatus === "agency") return result;
    result.phones = phones(document);
    result.phone = result.phones[0] || "";
    return result;
  }

  globalThis.AbateParser = Object.freeze({ normalize, isAllowedUrl, itemId, extractSearch, extractDetail, isVisible: visible, visibleText: text });
})();
