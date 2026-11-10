/*
 * BestImage content script
 * ---------------------------------------------------------------------------
 * Two jobs:
 *
 * 1. Work out the highest-quality URL for the image under the cursor (using
 *    srcset, lazy-load data-*, wrapping links and per-site URL rules).
 *
 * 2. Make Chrome's own "Open image in new tab" / "Save image as" use it.
 *    To do that we preload a nearly invisible copy of the <img> and place it
 *    over the original only after it has finished loading.  This avoids
 *    Chrome's native "Load image" item on healthy page images.  The copy is
 *    wrapped in a clone of the original <a> so link actions remain available.
 *
 * Also removes the most common "right click disabled" road blocks.  Holding
 * Alt while right-clicking always bypasses this script for one click.
 */
(function () {
  'use strict';

  const BI = typeof globalThis !== 'undefined' ? globalThis.BestImage : null;
  if (!BI) return;
  if (window.__bestImageOpenerActive) return;
  window.__bestImageOpenerActive = true;

  const HAS_EXT = !!(
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    chrome.runtime.id &&
    chrome.storage &&
    chrome.storage.sync
  );

  let settings = Object.assign({}, BI.DEFAULT_SETTINGS);
  let siteDisabled = false;
  let proxy = null;
  let proxyCleanupTimer = 0;
  const proxyLoaders = new WeakMap();
  const proxyLoaderOrder = [];
  const MAX_PROXY_LOADERS = 20;
  let toastTimer = 0;

  function refreshSiteState() {
    siteDisabled = BI.isDisabledSite(location.hostname, settings.disabledSites);
  }

  function loadSettings() {
    if (!HAS_EXT) {
      try {
        const raw = localStorage.getItem('best-image-settings');
        if (raw) settings = Object.assign({}, BI.DEFAULT_SETTINGS, JSON.parse(raw));
      } catch (e) {
        /* ignore */
      }
      refreshSiteState();
      return;
    }
    try {
      chrome.storage.sync.get(BI.DEFAULT_SETTINGS, (value) => {
        settings = Object.assign({}, BI.DEFAULT_SETTINGS, value || {});
        refreshSiteState();
      });
    } catch (e) {
      /* extension was reloaded; keep defaults */
    }
  }

  loadSettings();

  if (HAS_EXT) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const key of Object.keys(changes)) {
          settings[key] = changes[key].newValue;
        }
        refreshSiteState();
      });
    } catch (e) {
      /* ignore */
    }
  }

  /* ------------------------------------------------------------------ */
  /* URL resolution                                                      */
  /* ------------------------------------------------------------------ */

  function attrScore(name) {
    if (/(original|full|large|raw|hires|highres|zoom|master|origin|source)/.test(name)) return 40;
    if (/(actual|real|hd|big)/.test(name)) return 30;
    return 10;
  }

  function getBackgroundUrl(el) {
    let bg = '';
    try {
      bg = getComputedStyle(el).backgroundImage || '';
    } catch (e) {
      return '';
    }
    if (!bg || bg === 'none') return '';
    const m = bg.match(/url\((["']?)(.*?)\1\)/i);
    if (!m || !m[2]) return '';
    return m[2];
  }

  function collectEntries(hit, pageUrl) {
    const entries = [];
    const seen = new Map();

    function add(raw, score, from) {
      if (raw == null) return;
      let value = String(raw).trim();
      if (!value) return;
      const cssUrl = value.match(/url\((["']?)(.*?)\1\)/i);
      if (cssUrl && cssUrl[2]) value = cssUrl[2];
      if (/^data:/i.test(value)) return;
      const abs = BI.absUrl(value, pageUrl);
      if (!abs || !/^https?:\/\//i.test(abs)) return;
      if (BI.isPlaceholderUrl(abs)) return;
      const prev = seen.get(abs);
      if (prev) {
        if (score > prev.score) {
          prev.score = score;
          prev.from = from;
        }
        return;
      }
      const entry = { url: abs, score, from };
      seen.set(abs, entry);
      entries.push(entry);
    }

    const el = hit.el;

    if (hit.kind === 'background') {
      add(hit.url, 70, 'background-image');
    } else if (hit.kind === 'svg') {
      add(hit.url, 95, 'svg:image');
    } else if (hit.kind === 'video') {
      add(hit.url, 45, 'video:poster');
    } else if (el && el.tagName === 'IMG') {
      add(el.currentSrc, 40, 'currentSrc');
      add(el.getAttribute('src'), 30, 'src');
    }

    if (el && el.attributes) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (!name.startsWith('data-')) continue;
        const value = attr.value;
        if (!value) continue;
        if (/srcset/i.test(name)) {
          const best = BI.pickFromSrcset(value, pageUrl);
          if (best) add(best, 78, name);
          continue;
        }
        if (!/(src|original|image|img|url|pic|photo|lazy|zoom|full|large|raw|hd|big|origin|actual)/i.test(name)) continue;
        if (/(thumb|small|mini|icon|avatar|placeholder|preview|low)/i.test(name)) continue;
        add(value, 60 + attrScore(name), name);
      }
    }

    if (el && el.tagName === 'IMG') {
      const srcset = el.getAttribute('srcset');
      if (srcset) {
        const best = BI.pickFromSrcset(srcset, pageUrl);
        if (best) add(best, 75 + Math.min(BI.widthHint(best) / 200, 20), 'srcset');
      }
      let picture = null;
      try {
        picture = el.closest('picture');
      } catch (e) {
        /* ignore */
      }
      if (picture) {
        picture.querySelectorAll('source').forEach((source) => {
          const set = source.getAttribute('srcset') || source.getAttribute('data-srcset');
          if (!set) return;
          const best = BI.pickFromSrcset(set, pageUrl);
          if (best) add(best, 78, 'picture>source');
        });
      }
    }

    if (hit.linkUrl && BI.isImageUrl(hit.linkUrl)) {
      add(hit.linkUrl, 90, 'link[href]');
    }

    return entries;
  }

  function resolveHit(hit) {
    const pageUrl = document.baseURI || location.href;
    const displayUrl = BI.absUrl(hit.url, pageUrl) || hit.url || '';
    const entries = collectEntries(hit, pageUrl);
    if (!entries.length) {
      return { url: displayUrl, displayUrl, candidates: [], changed: false, rule: null, from: null };
    }

    const variants = [];
    for (const entry of entries) {
      variants.push({ url: entry.url, score: entry.score, from: entry.from, rule: null });
      const up = BI.upgradeUrl(entry.url, pageUrl);
      if (up.changed) {
        up.candidates.forEach((candidate, index) => {
          variants.push({
            url: candidate,
            score: entry.score + 50 - index * 5,
            from: entry.from,
            rule: up.rule,
          });
        });
      }
    }

    const bestByUrl = new Map();
    for (const variant of variants) {
      const prev = bestByUrl.get(variant.url);
      if (!prev || variant.score > prev.score) bestByUrl.set(variant.url, variant);
    }
    const list = Array.from(bestByUrl.values());
    list.sort((a, b) => b.score - a.score || BI.widthHint(b.url) - BI.widthHint(a.url));

    const best = list[0];
    return {
      url: best.url,
      displayUrl,
      candidates: list.map((entry) => entry.url),
      changed: best.url !== displayUrl,
      rule: best.rule,
      from: best.from,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Hit testing                                                         */
  /* ------------------------------------------------------------------ */

  function describeNode(node) {
    if (!node || node.nodeType !== 1) return null;
    const tag = node.tagName;
    if (tag === 'IMG') {
      const src = node.currentSrc || node.src || node.getAttribute('src') || '';
      // Keep going even when src is empty: lazy-loading images often have the
      // real URL only in data-src / data-original.
      return { el: node, kind: 'img', url: src, linkUrl: linkOf(node) };
    }
    if (tag === 'IMAGE' && String(node.namespaceURI || '').indexOf('svg') !== -1) {
      const href = node.getAttribute('href') || node.getAttribute('xlink:href') || '';
      if (!href) return null;
      return { el: node, kind: 'svg', url: href, linkUrl: linkOf(node) };
    }
    if (tag === 'VIDEO' && node.poster) {
      return { el: node, kind: 'video', url: node.poster, linkUrl: linkOf(node) };
    }
    return null;
  }

  function linkOf(el) {
    try {
      const a = el.closest && el.closest('a[href]');
      if (!a) return '';
      const href = a.getAttribute('href') || '';
      if (!href || href === '#' || /^javascript:/i.test(href)) return '';
      return BI.absUrl(href, document.baseURI || location.href) || '';
    } catch (e) {
      return '';
    }
  }

  function findImageAt(event) {
    if (proxy && (event.target === proxy.el || proxy.node.contains(event.target))) {
      return proxy.hit;
    }

    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    for (const node of path) {
      const described = describeNode(node);
      if (described) {
        described.overlaid = false;
        return described;
      }
    }

    let stack = [];
    try {
      stack = document.elementsFromPoint(event.clientX, event.clientY) || [];
    } catch (e) {
      stack = [];
    }

    // Prefer a real <img> under any overlay, then fall back to CSS backgrounds.
    for (const node of stack) {
      if (proxy && node === proxy.el) return proxy.hit;
      const described = describeNode(node);
      if (described) {
        described.overlaid = true;
        return described;
      }
    }
    for (const node of stack) {
      if (!node || node.nodeType !== 1) continue;
      if (node === document.body || node === document.documentElement) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) continue;
      // A full-page body/section background with lots of text is decoration.
      // Opening it as an image on every right click would be surprising.
      if (
        rect.width * rect.height > window.innerWidth * window.innerHeight * 0.85 &&
        (node.innerText || '').trim().length > 80
      ) {
        continue;
      }
      const bg = getBackgroundUrl(node);
      if (bg) return { el: node, kind: 'background', url: bg, linkUrl: linkOf(node), overlaid: true };
    }
    return null;
  }

  /* ------------------------------------------------------------------ */
  /* The invisible proxy                                                 */
  /* ------------------------------------------------------------------ */

  const IMPORTANT = {
    position: 'fixed',
    margin: '0',
    padding: '0',
    border: '0',
    'box-sizing': 'border-box',
    'max-width': 'none',
    'max-height': 'none',
    'min-width': '0',
    'min-height': '0',
    transform: 'none',
    'transform-origin': '0 0',
    visibility: 'visible',
    display: 'block',
    'background-color': 'transparent',
    'box-shadow': 'none',
    'border-radius': '0',
    filter: 'none',
    'clip-path': 'none',
    'mix-blend-mode': 'normal',
    transition: 'none',
    animation: 'none',
    'z-index': '2147483647',
    'pointer-events': 'auto',
  };

  function applyStyles(el, rect, opacity) {
    for (const key of Object.keys(IMPORTANT)) {
      el.style.setProperty(key, IMPORTANT[key], 'important');
    }
    el.style.setProperty('left', rect.left + 'px', 'important');
    el.style.setProperty('top', rect.top + 'px', 'important');
    el.style.setProperty('width', rect.width + 'px', 'important');
    el.style.setProperty('height', rect.height + 'px', 'important');
    el.style.setProperty('opacity', opacity, 'important');
  }

  function removeProxy() {
    clearTimeout(proxyCleanupTimer);
    if (proxy && proxy.loader) proxy.loader.attached = false;
    if (proxy && proxy.node && proxy.node.parentNode) {
      proxy.node.parentNode.removeChild(proxy.node);
    }
    proxy = null;
  }

  function scheduleRemove() {
    clearTimeout(proxyCleanupTimer);
    proxyCleanupTimer = setTimeout(removeProxy, 0);
  }

  function proxyUrls(resolved) {
    const urls = [];
    for (const candidate of [resolved.url].concat(resolved.candidates || [], [resolved.displayUrl])) {
      if (candidate && /^https?:\/\//i.test(candidate) && !urls.includes(candidate)) urls.push(candidate);
    }
    return urls;
  }

  function createProxyLoader(hit, resolved) {
    const urls = proxyUrls(resolved);
    if (!urls.length) return null;
    const img = document.createElement('img');
    img.setAttribute('data-best-image-proxy', '1');
    img.setAttribute('data-best-image-proxy-loader', '1');
    img.setAttribute('aria-hidden', 'true');
    img.alt = '';
    img.decoding = 'async';
    img.draggable = false;

    const loader = {
      url: resolved.url,
      hit,
      resolved,
      urls,
      index: 0,
      img,
      loaded: false,
      failed: false,
      attached: false,
      createdAt: Date.now(),
    };

    img.addEventListener('load', () => {
      if (!loader.failed) loader.loaded = true;
    });

    img.addEventListener('error', () => {
      if (loader.failed) return;
      loader.index += 1;
      if (loader.index < loader.urls.length) {
        img.src = loader.urls[loader.index];
      } else {
        loader.failed = true;
      }
    });

    proxyLoaders.set(hit.el, loader);
    proxyLoaderOrder.push(loader);
    while (proxyLoaderOrder.length > MAX_PROXY_LOADERS) {
      const old = proxyLoaderOrder.shift();
      if (old && !old.attached && proxyLoaders.get(old.hit.el) === old) {
        proxyLoaders.delete(old.hit.el);
      }
    }

    img.src = urls[0];
    return loader;
  }

  function getProxyLoader(hit, resolved) {
    const existing = proxyLoaders.get(hit.el);
    if (existing && existing.url === resolved.url) return existing;
    return createProxyLoader(hit, resolved);
  }

  function preloadProxy(hit, resolved) {
    if (!settings.proxy || !hit || !resolved || !resolved.url) return;
    getProxyLoader(hit, resolved);
  }

  function ensureProxy(hit, resolved) {
    if (!settings.proxy) return;
    if (!resolved || !resolved.url) return;
    if (
      proxy &&
      proxy.hit.el === hit.el &&
      proxy.url === resolved.url &&
      proxy.node &&
      proxy.node.isConnected
    ) {
      return;
    }

    const loader = getProxyLoader(hit, resolved);
    removeProxy();
    // Do not attach a new <img> until it has actually loaded.  Otherwise
    // Chrome adds a native "Load image" item to the context menu for a
    // perfectly healthy page image.  When the proxy is not ready yet, the
    // page's own image keeps the native menu clean and the extension's own
    // menu still has the resolved URL.
    if (!loader || !loader.loaded || loader.failed || !loader.img.complete) return;

    const rect = hit.el.getBoundingClientRect();
    if (!rect || rect.width < 2 || rect.height < 2) return;

    const img = loader.img;
    let node = img;
    if (hit.linkUrl && /^https?:\/\//i.test(hit.linkUrl)) {
      const anchor = document.createElement('a');
      anchor.href = hit.linkUrl;
      anchor.setAttribute('data-best-image-proxy', '1');
      anchor.setAttribute('aria-hidden', 'true');
      anchor.appendChild(img);
      applyStyles(anchor, rect, '0.01');
      applyStyles(img, rect, '1');
      node = anchor;

      img.style.setProperty('position', 'absolute', 'important');
      img.style.setProperty('left', '0', 'important');
      img.style.setProperty('top', '0', 'important');
      img.style.setProperty('width', '100%', 'important');
      img.style.setProperty('height', '100%', 'important');
      img.style.setProperty('object-fit', 'fill', 'important');
    } else {
      applyStyles(img, rect, '0.01');
    }

    document.documentElement.appendChild(node);
    loader.attached = true;
    proxy = {
      node,
      el: img,
      hit,
      resolved,
      url: resolved.url,
      loader,
      createdAt: Date.now(),
    };

    clearTimeout(proxyCleanupTimer);
    proxyCleanupTimer = setTimeout(removeProxy, 15000);
  }

  /* ------------------------------------------------------------------ */
  /* Optional: rewrite the page image itself                             */
  /* ------------------------------------------------------------------ */

  function maybeRewrite(hit, resolved) {
    if (!settings.rewrite || hit.kind !== 'img' || hit.overlaid) return;
    if (!resolved.changed || !/^https?:\/\//i.test(resolved.url)) return;

    const img = hit.el;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset.bestImageRewritten === resolved.url) return;

    const oldSrc = img.getAttribute('src');
    if (!oldSrc) return;
    const oldSrcset = img.getAttribute('srcset');

    function restore() {
      img.removeEventListener('error', onError);
      if (oldSrcset == null) img.removeAttribute('srcset');
      else img.setAttribute('srcset', oldSrcset);
      img.setAttribute('src', oldSrc);
      delete img.dataset.bestImageRewritten;
    }
    function onError() {
      restore();
    }

    img.dataset.bestImageRewritten = resolved.url;
    img.addEventListener('error', onError, { once: true });
    img.removeAttribute('srcset');
    img.src = resolved.url;
  }

  /* ------------------------------------------------------------------ */
  /* Messaging / toast                                                   */
  /* ------------------------------------------------------------------ */

  function sendContext(hit, resolved) {
    if (!HAS_EXT) return;
    try {
      const result = chrome.runtime.sendMessage({
        type: 'best-image:context',
        url: resolved.url,
        displayUrl: resolved.displayUrl,
        candidates: resolved.candidates.slice(0, 12),
        changed: resolved.changed,
        rule: resolved.rule,
        kind: hit.kind,
        pageUrl: location.href,
        referrerPolicy: hit.el.referrerPolicy || '',
      });
      if (result && typeof result.catch === 'function') result.catch(() => {});
    } catch (e) {
      /* extension context invalidated */
    }
  }

  function showToast(resolved) {
    if (!settings.toast || !document.documentElement) return;
    const host = ensureToastHost();
    if (!host) return;
    const box = host.shadowRoot && host.shadowRoot.querySelector('.box');
    if (!box) return;
    const rule = resolved.rule ? ` · ${resolved.rule}` : '';
    box.textContent = resolved.changed ? `已识别更高画质${rule}` : '当前已是可获取的最高画质';
    host.style.setProperty('opacity', '1', 'important');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      host.style.setProperty('opacity', '0', 'important');
    }, 2200);
  }

  function ensureToastHost() {
    let host = document.getElementById('best-image-opener-toast');
    if (host) return host;
    host = document.createElement('div');
    host.id = 'best-image-opener-toast';
    host.setAttribute('aria-live', 'polite');
    host.style.setProperty('position', 'fixed', 'important');
    host.style.setProperty('left', '50%', 'important');
    host.style.setProperty('bottom', '28px', 'important');
    host.style.setProperty('transform', 'translateX(-50%)', 'important');
    host.style.setProperty('z-index', '2147483647', 'important');
    host.style.setProperty('pointer-events', 'none', 'important');
    host.style.setProperty('opacity', '0', 'important');
    host.style.setProperty('transition', 'opacity .2s ease', 'important');
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML =
      '<style>' +
      '.box{background:rgba(17,24,39,.92);color:#fff;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'padding:8px 14px;border-radius:999px;box-shadow:0 8px 24px rgba(0,0,0,.35);white-space:nowrap;}' +
      '</style><div class="box"></div>';
    document.documentElement.appendChild(host);
    return host;
  }

  /* ------------------------------------------------------------------ */
  /* Event wiring                                                        */
  /* ------------------------------------------------------------------ */

  let lastPreload = { el: null, at: 0 };

  function onPointerOver(event) {
    if (event.altKey || !settings.enabled || siteDisabled || !settings.proxy) return;
    const now = Date.now();
    const hit = findImageAt(event);
    if (!hit) return;
    if (lastPreload.el === hit.el && now - lastPreload.at < 1000) return;
    lastPreload = { el: hit.el, at: now };

    const resolved = resolveHit(hit);
    if (!resolved.url) return;
    const needsProxy = hit.kind !== 'img' || hit.overlaid || resolved.changed;
    if (needsProxy) preloadProxy(hit, resolved);
  }

  function onMouseDown(event) {
    if (event.button !== 2 || event.altKey) return;
    if (!settings.enabled || siteDisabled) return;
    if (proxy && (event.target === proxy.el || proxy.node.contains(event.target))) return;

    const hit = findImageAt(event);
    if (!hit) return;

    const resolved = resolveHit(hit);
    if (!resolved.url) return;

    const needsProxy = hit.kind !== 'img' || hit.overlaid || resolved.changed;
    if (needsProxy) {
      preloadProxy(hit, resolved);
      ensureProxy(hit, resolved);
    }
    maybeRewrite(hit, resolved);
  }

  function onContextMenu(event) {
    if (event.altKey) return;
    if (!settings.enabled || siteDisabled) return;

    let hit = null;
    let resolved = null;

    if (proxy && (event.target === proxy.el || proxy.node.contains(event.target))) {
      hit = proxy.hit;
      resolved = proxy.resolved;
    } else {
      hit = findImageAt(event);
      if (!hit) return;
      resolved = resolveHit(hit);
    }
    if (!hit || !resolved || !resolved.url) return;

    // The page can no longer cancel the native menu.  We do NOT call
    // preventDefault ourselves: the native menu stays available.
    if (settings.unblock) {
      event.stopImmediatePropagation();
    }

    if (settings.proxy && !proxy) {
      const needsProxy = hit.kind !== 'img' || hit.overlaid || resolved.changed;
      if (needsProxy) {
        preloadProxy(hit, resolved);
        ensureProxy(hit, resolved);
      }
    }
    if (settings.rewrite) maybeRewrite(hit, resolved);

    sendContext(hit, resolved);
    if (settings.toast) showToast(resolved);
  }

  window.addEventListener('pointerover', onPointerOver, true);
  window.addEventListener('mousedown', onMouseDown, true);
  window.addEventListener('contextmenu', onContextMenu, true);

  window.addEventListener(
    'mousedown',
    (event) => {
      if (proxy && event.button !== 2) scheduleRemove();
    },
    true
  );
  window.addEventListener('scroll', scheduleRemove, { capture: true, passive: true });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') scheduleRemove();
  }, true);
})();
