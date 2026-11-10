/*
 * BestImage service worker (MV3)
 * ---------------------------------------------------------------------------
 * - adds three entries to Chrome's native image context menu
 * - opens the resolved URL and, for the new tab only, spoofs the Referer so
 *   hot-link protected CDNs (Weibo, Pixiv, ...) actually return the image
 * - clipboard + download helpers
 */
importScripts(chrome.runtime.getURL('src/resolver.js'));

const BI = self.BestImage;
const DEFAULTS = BI.DEFAULT_SETTINGS;

const MENU_OPEN = 'best-image-open';
const MENU_COPY = 'best-image-copy';
const MENU_DOWNLOAD = 'best-image-download';

let settingsCache = null;
let contextByFrame = new Map(); // "tabId:frameId" -> context, short lived
let offscreenPromise = null;
let imageConversionPromise = null;

function loadSettings() {
  if (!settingsCache) {
    settingsCache = chrome.storage.sync
      .get(DEFAULTS)
      .then((value) => Object.assign({}, DEFAULTS, value || {}))
      .catch(() => Object.assign({}, DEFAULTS));
  }
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  settingsCache = null;
});

/* ------------------------------------------------------------------ */
/* Menus                                                               */
/* ------------------------------------------------------------------ */

function createMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_OPEN,
      title: '打开原图（新标签页）',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_COPY,
      title: '复制原图地址',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_DOWNLOAD,
      title: '下载原图',
      contexts: ['image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(createMenus);
chrome.runtime.onStartup.addListener(createMenus);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== 'best-image:context' || !sender.tab) return;
  const frameId = sender.frameId == null ? 0 : sender.frameId;
  contextByFrame.set(sender.tab.id + ':' + frameId, {
    tabId: sender.tab.id,
    frameId,
    url: message.url,
    displayUrl: message.displayUrl,
    pageUrl: message.pageUrl || sender.tab.url || '',
    referrerPolicy: message.referrerPolicy || '',
    rule: message.rule || null,
    at: Date.now(),
  });
  // Keep the map small.
  if (contextByFrame.size > 50) {
    const now = Date.now();
    for (const [key, value] of contextByFrame) {
      if (now - value.at > 60000) contextByFrame.delete(key);
    }
  }
  sendResponse({ ok: true });
});

function getContext(tabId, frameId) {
  if (tabId == null) return null;
  const key = tabId + ':' + (frameId == null ? 0 : frameId);
  const value = contextByFrame.get(key);
  if (!value) return null;
  if (Date.now() - value.at > 60000) {
    contextByFrame.delete(key);
    return null;
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* Referer rules                                                       */
/* ------------------------------------------------------------------ */

let idChain = Promise.resolve(0);

function nextRuleId() {
  idChain = idChain.then(async (last) => {
    if (last) return last + 1;
    const rules = await chrome.declarativeNetRequest.getSessionRules().catch(() => []);
    return rules.reduce((max, rule) => Math.max(max, rule.id), 0) + 1;
  });
  return idChain;
}

async function addRefererRule(tabId, targetUrl, referer) {
  let host = '';
  try {
    host = new URL(targetUrl).hostname;
  } catch (e) {
    return;
  }
  if (!host || !/^https?:/i.test(referer) || !/^https?:/i.test(targetUrl)) return;

  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    if (rules.length > 4500) return; // stay well below Chrome's limit
    const id = await nextRuleId();
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [
        {
          id,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: [{ header: 'Referer', operation: 'set', value: referer }],
          },
          condition: {
            tabIds: [tabId],
            requestDomains: [host],
            resourceTypes: ['main_frame', 'image', 'media', 'xmlhttprequest', 'other'],
          },
        },
      ],
    });
  } catch (e) {
    // Not fatal: many images work without a Referer.
    console.warn('[BestImage] could not add Referer rule:', e);
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  pendingOpens.delete(tabId);
  try {
    const rules = await chrome.declarativeNetRequest.getSessionRules();
    const ids = rules
      .filter((rule) => Array.isArray(rule.condition.tabIds) && rule.condition.tabIds.includes(tabId))
      .map((rule) => rule.id);
    if (ids.length) {
      await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: ids });
    }
  } catch (e) {
    /* ignore */
  }
});

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const pendingOpens = new Map(); // tabId -> { list, index, referer, startedAt }

function needsRasterConversion(url) {
  return /(?:\.webp|\.avif)(?:[?#]|$)/i.test(url) ||
    /[?&](?:format|fm|image_format)=(?:webp|avif)\b/i.test(url) ||
    /(?:^|[!/_-])(?:webp|avif)(?:[!/_?-]|$)/i.test(url);
}

async function convertToPng(url, referer) {
  if (!needsRasterConversion(url)) return null;
  await ensureOffscreen();
  if (imageConversionPromise) return imageConversionPromise;
  imageConversionPromise = chrome.runtime.sendMessage({
    target: 'best-image-offscreen',
    type: 'convert-image',
    url,
    referer,
  }).finally(() => {
    imageConversionPromise = null;
  });
  const result = await imageConversionPromise;
  if (!result || !result.ok || !result.dataUrl) {
    console.warn('[BestImage] image format conversion failed:', result && result.error);
    return null;
  }
  return result;
}

async function prepareImageAsset(target, referer) {
  const converted = await convertToPng(target, referer).catch((error) => {
    console.warn('[BestImage] image format conversion failed:', error);
    return null;
  });
  if (!converted) return { url: target, extension: null, converted: false };
  return { url: converted.dataUrl, extension: converted.extension || 'png', converted: true };
}

async function openOriginal(target, tab, context) {
  const settings = await loadSettings();
  const referer =
    (context && context.pageUrl) ||
    (tab && tab.url) ||
    '';
  const policy = (context && context.referrerPolicy) || '';
  const useReferer = !!(settings.referer && !/no-referrer/i.test(policy) && /^https?:/i.test(referer));
  const asset = await prepareImageAsset(target, referer);
  const openTarget = asset.url;

  const list = [openTarget];
  if (asset.converted) {
    const createOptions = {
      url: 'about:blank',
      active: !settings.openInBackground,
    };
    if (tab && tab.id != null) createOptions.openerTabId = tab.id;
    if (tab && typeof tab.index === 'number') createOptions.index = tab.index + 1;
    const created = await chrome.tabs.create(createOptions);
    if (!created || created.id == null) {
      return chrome.tabs.create({ url: openTarget, active: !settings.openInBackground });
    }
    pendingOpens.set(created.id, {
      list,
      index: 0,
      referer: '',
      startedAt: Date.now(),
    });
    await chrome.tabs.update(created.id, { url: openTarget }).catch(() => {});
    return created;
  }

  const extra = context && Array.isArray(context.candidates) ? context.candidates : [];
  for (const url of extra) {
    if (list.length >= 4) break;
    if (typeof url === 'string' && /^https?:/i.test(url) && list.indexOf(url) < 0) list.push(url);
  }

  const createOptions = {
    url: 'about:blank',
    active: !settings.openInBackground,
  };
  if (tab && tab.id != null) createOptions.openerTabId = tab.id;
  if (tab && typeof tab.index === 'number') createOptions.index = tab.index + 1;

  const created = await chrome.tabs.create(createOptions);
  if (!created || created.id == null) {
    return chrome.tabs.create({ url: target, active: !settings.openInBackground });
  }

  // The Referer rule only affects requests that start *after* it exists.  A
  // tab created directly with the target URL has already fired its main-frame
  // request, so Weibo's image CDN answers 403.  Open blank, install the rule,
  // then navigate.
  if (useReferer) {
    try {
      await addRefererRule(created.id, list[0], referer);
    } catch (e) {
      console.warn('[BestImage] referer rule failed:', e);
    }
  }

  pendingOpens.set(created.id, {
    list,
    index: 0,
    referer: useReferer ? referer : '',
    startedAt: Date.now(),
  });
  await chrome.tabs.update(created.id, { url: list[0] }).catch(() => {});
  return created;
}

async function advanceFailedOpen(tabId) {
  const job = pendingOpens.get(tabId);
  if (!job) return;
  if (job.index + 1 >= job.list.length) {
    pendingOpens.delete(tabId);
    return;
  }
  job.index += 1;
  const next = job.list[job.index];
  if (job.referer) {
    try {
      await addRefererRule(tabId, next, job.referer);
    } catch (e) {
      /* not fatal */
    }
  }
  await chrome.tabs.update(tabId, { url: next }).catch(() => {});
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo || changeInfo.status !== 'complete') return;
  const job = pendingOpens.get(tabId);
  if (!job) return;
  if (!tab || !tab.url || tab.url === 'about:blank') return;
  if (Date.now() - job.startedAt < 700) return;
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: () => {
        const type = (document && document.contentType) || '';
        if (/^image\//i.test(type)) return true;
        return !!(document.body && document.body.querySelector('img'));
      },
    })
    .then(([res]) => {
      if (res && res.result) {
        pendingOpens.delete(tabId);
      } else {
        advanceFailedOpen(tabId);
      }
    })
    .catch((e) => {
      // Only a Chrome error page means the load really failed.  Any other
      // scripting restriction is "unknown", and we keep the current image
      // instead of silently downgrading to a smaller candidate.
      const msg = String((e && e.message) || e || '');
      if (/chrome-error|error page|ERR_/i.test(msg)) advanceFailedOpen(tabId);
      else pendingOpens.delete(tabId);
    });
});

function filenameFor(url, forcedExtension) {
  try {
    const u = new URL(url);
    let base = decodeURIComponent((u.pathname.split('/').pop() || '').replace(/\+/g, ' '));
    base = base.replace(/[\\/:*?"<>|\r\n\t]+/g, '_').trim().slice(0, 90);
    if (!base || /^\d{1,4}$/.test(base)) {
      base = base ? 'image-' + base : 'image';
    }
    if (forcedExtension) {
      base = base.replace(/\.[a-z0-9]{2,5}$/i, '');
      base = (base || 'image') + '.' + forcedExtension;
    } else if (!/\.[a-z0-9]{2,5}$/i.test(base)) {
      let ext = u.searchParams.get('wx_fmt') || u.searchParams.get('format') || '';
      const pathQuery = u.search.match(/format\/(png|jpe?g|webp|gif|avif)/i);
      if (!ext && pathQuery) ext = pathQuery[1];
      ext = String(ext).toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!/^(?:jpe?g|png|gif|webp|avif)$/.test(ext)) ext = 'jpg';
      base = (base || 'image') + '.' + ext;
    }
    return base || undefined;
  } catch (e) {
    return undefined;
  }
}

async function downloadOriginal(url, tab, context) {
  try {
    const referer =
      (context && context.pageUrl) ||
      (tab && tab.url) ||
      '';
    const asset = await prepareImageAsset(url, referer);
    await chrome.downloads.download({
      url: asset.url,
      filename: filenameFor(asset.url, asset.extension),
      conflictAction: 'uniquify',
      saveAs: false,
    });
    flashBadge(tab && tab.id, '↓');
  } catch (e) {
    console.warn('[BestImage] download failed:', e);
    flashBadge(tab && tab.id, '!');
  }
}

/* ------------------------------------------------------------------ */
/* Clipboard (offscreen document)                                      */
/* ------------------------------------------------------------------ */

async function ensureOffscreen() {
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = (async () => {
    try {
      if (chrome.runtime.getContexts) {
        const contexts = await chrome.runtime.getContexts({
          contextTypes: ['OFFSCREEN_DOCUMENT'],
          documentUrls: [chrome.runtime.getURL('src/offscreen.html')],
        });
        if (contexts.length) return;
      }
      await chrome.offscreen.createDocument({
        url: 'src/offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: '把原图地址写入剪贴板',
      });
    } catch (e) {
      const message = String(e || '');
      if (!/single offscreen|already exists/i.test(message)) {
        console.warn('[BestImage] offscreen failed:', e);
      }
    }
  })().finally(() => {
    offscreenPromise = null;
  });
  return offscreenPromise;
}

async function copyText(text, tab) {
  await ensureOffscreen();
  try {
    const result = await chrome.runtime.sendMessage({
      target: 'best-image-offscreen',
      type: 'copy',
      text,
    });
    if (result && result.ok) {
      flashBadge(tab && tab.id, '✓');
      return true;
    }
  } catch (e) {
    /* fall through */
  }

  // Fallback for the rare case where the offscreen document cannot be used.
  if (tab && tab.id != null) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (value) => {
          const area = document.createElement('textarea');
          area.value = value;
          area.setAttribute('readonly', '');
          area.style.cssText = 'position:fixed;left:-9999px;top:0;';
          document.documentElement.appendChild(area);
          area.select();
          let ok = false;
          try {
            ok = document.execCommand('copy');
          } catch (e) {
            ok = false;
          }
          area.remove();
          return ok;
        },
        args: [text],
      });
      if (result && result.result) {
        flashBadge(tab.id, '✓');
        return true;
      }
    } catch (e) {
      /* ignore */
    }
  }
  flashBadge(tab && tab.id, '!');
  return false;
}

function flashBadge(tabId, text) {
  if (tabId == null) return;
  try {
    const color = chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
    if (color && color.catch) color.catch(() => {});
    const badge = chrome.action.setBadgeText({ tabId, text });
    if (badge && badge.catch) badge.catch(() => {});
    setTimeout(() => {
      try {
        const clear = chrome.action.setBadgeText({ tabId, text: '' });
        if (clear && clear.catch) clear.catch(() => {});
      } catch (e) {
        /* ignore */
      }
    }, 1600);
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Menu clicks                                                         */
/* ------------------------------------------------------------------ */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!info || !info.menuItemId || !String(info.menuItemId).startsWith('best-image-')) return;
  handleMenuClick(info, tab).catch((e) => {
    console.warn('[BestImage] menu action failed:', e);
  });
});

async function handleMenuClick(info, tab) {
  const tabId = tab && tab.id;
  const context = getContext(tabId, info.frameId);
  const srcUrl = info.srcUrl || '';
  let target = srcUrl;

  // The content script's proxy makes info.srcUrl already point at the resolved
  // image, which is always the freshest value.  Only fall back to the stored
  // context when the native target is still the un-upgraded page image (proxy
  // disabled / unavailable) or is not an http(s) URL (data:, blob:).
  if (!target || (context && context.url && (target === context.displayUrl || !/^https?:/i.test(target)))) {
    target = (context && context.url) || target;
  }
  if (!target) return;

  if (info.menuItemId === MENU_OPEN) {
    if (/^https?:/i.test(target)) {
      await openOriginal(target, tab, context);
    }
    return;
  }
  if (info.menuItemId === MENU_COPY) {
    await copyText(target, tab);
    return;
  }
  if (info.menuItemId === MENU_DOWNLOAD) {
    await downloadOriginal(target, tab, context);
  }
}
