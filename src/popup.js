(function () {
  'use strict';

  const DEFAULTS = window.BestImage.DEFAULT_SETTINGS;
  const $ = (id) => document.getElementById(id);

  let settings = Object.assign({}, DEFAULTS);
  let currentHost = '';
  let bannerTimer = 0;

  function showBanner(text) {
    const banner = $('banner');
    banner.textContent = text;
    banner.classList.add('show');
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => banner.classList.remove('show'), 1400);
  }

  async function save(patch) {
    settings = Object.assign({}, settings, patch);
    render();
    try {
      await chrome.storage.sync.set(patch);
      showBanner('已保存');
    } catch (e) {
      showBanner('保存失败：' + e.message);
    }
  }

  function render() {
    $('enabled').checked = !!settings.enabled;
    document.querySelectorAll('[data-key]').forEach((input) => {
      input.checked = !!settings[input.dataset.key];
    });

    const hasSite = !!currentHost;
    $('siteRow').hidden = !hasSite;
    $('siteUnavailable').hidden = hasSite;
    if (!hasSite) {
      $('siteHost').textContent = '此页面不可用';
      $('siteDot').className = 'dot off';
      return;
    }

    const disabled = window.BestImage.isDisabledSite(currentHost, settings.disabledSites);
    $('siteHost').textContent = currentHost;
    $('siteHost').title = currentHost;
    $('siteDot').className = 'dot' + (disabled || !settings.enabled ? ' off' : '');
    $('siteToggle').checked = !disabled;
    $('siteState').textContent = disabled ? '此网站已停用' : '在此网站启用';
  }

  async function init() {
    try {
      settings = Object.assign({}, DEFAULTS, await chrome.storage.sync.get(DEFAULTS));
    } catch (e) {
      settings = Object.assign({}, DEFAULTS);
    }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.url) {
        const url = new URL(tab.url);
        if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') {
          currentHost = url.hostname || (url.protocol === 'file:' ? '本地文件' : '');
        }
      }
    } catch (e) {
      currentHost = '';
    }

    render();

    $('enabled').addEventListener('change', (event) => {
      save({ enabled: event.target.checked });
    });

    document.querySelectorAll('[data-key]').forEach((input) => {
      input.addEventListener('change', () => {
        const patch = {};
        patch[input.dataset.key] = input.checked;
        save(patch);
      });
    });

    $('siteToggle').addEventListener('change', () => {
      if (!currentHost) return;
      const list = (settings.disabledSites || []).filter(
        (entry) => !window.BestImage.isDisabledSite(currentHost, [entry])
      );
      if (!$('siteToggle').checked) {
        list.push(currentHost.replace(/^www\./, ''));
      }
      save({ disabledSites: Array.from(new Set(list)) });
    });

    $('options').addEventListener('click', () => {
      chrome.runtime.openOptionsPage();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'sync') return;
      for (const key of Object.keys(changes)) settings[key] = changes[key].newValue;
      render();
    });
  }

  init();
})();
