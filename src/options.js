(function () {
  'use strict';

  const DEFAULTS = window.BestImage.DEFAULT_SETTINGS;
  const $ = (id) => document.getElementById(id);

  let settings = Object.assign({}, DEFAULTS);
  let saveTimer = 0;
  let statusTimer = 0;
  let toastTimer = 0;

  function setStatus(text, saved) {
    const status = $('status');
    status.textContent = text;
    status.classList.toggle('saved', !!saved);
  }

  function toast(text) {
    const box = $('toast');
    box.textContent = text;
    box.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.remove('show'), 1600);
  }

  function normalizeSites(text) {
    const seen = new Set();
    const out = [];
    String(text || '')
      .split(/[\s,，;；]+/)
      .forEach((raw) => {
        let value = raw.trim().toLowerCase();
        if (!value) return;
        value = value.replace(/^https?:\/\//, '').split('/')[0].replace(/^\*\./, '').replace(/^www\./, '');
        value = value.replace(/:\d+$/, '');
        if (!value) return;
        if (!/^[a-z0-9.-]+$/.test(value)) return;
        if (seen.has(value)) return;
        seen.add(value);
        out.push(value);
      });
    return out;
  }

  function updateCount() {
    const count = normalizeSites($('sites').value).length;
    $('siteCount').textContent = count ? `已停用 ${count} 个网站` : '当前没有例外网站';
  }

  function renderToggles() {
    document.querySelectorAll('[data-key]').forEach((input) => {
      input.checked = !!settings[input.dataset.key];
    });
  }

  function render() {
    renderToggles();
    $('sites').value = (settings.disabledSites || []).join('\n');
    updateCount();
  }

  async function save(patch) {
    settings = Object.assign({}, settings, patch);
    renderToggles();
    try {
      await chrome.storage.sync.set(patch);
      setStatus('已保存', true);
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => setStatus('v' + chrome.runtime.getManifest().version), 1200);
    } catch (e) {
      setStatus('保存失败', false);
      toast('保存失败：' + e.message);
    }
  }

  async function saveSites() {
    const list = normalizeSites($('sites').value);
    $('sites').value = list.join('\n');
    updateCount();
    await save({ disabledSites: list });
  }

  async function init() {
    try {
      settings = Object.assign({}, DEFAULTS, await chrome.storage.sync.get(DEFAULTS));
    } catch (e) {
      settings = Object.assign({}, DEFAULTS);
    }
    $('version').textContent = chrome.runtime.getManifest().version;
    setStatus('v' + chrome.runtime.getManifest().version, false);
    render();

    document.querySelectorAll('[data-key]').forEach((input) => {
      input.addEventListener('change', () => {
        const patch = {};
        patch[input.dataset.key] = input.checked;
        save(patch);
      });
    });

    $('sites').addEventListener('input', () => {
      updateCount();
      clearTimeout(saveTimer);
      saveTimer = setTimeout(saveSites, 500);
    });
    $('sites').addEventListener('blur', () => {
      clearTimeout(saveTimer);
      saveSites();
    });

    $('clearSites').addEventListener('click', async () => {
      $('sites').value = '';
      updateCount();
      await save({ disabledSites: [] });
      toast('已清空网站例外');
    });

    $('reset').addEventListener('click', async () => {
      if (!confirm('恢复所有默认设置？网站例外列表也会被清空。')) return;
      settings = Object.assign({}, DEFAULTS);
      try {
        await chrome.storage.sync.set(DEFAULTS);
        render();
        setStatus('已恢复默认', true);
        toast('已恢复默认设置');
        clearTimeout(statusTimer);
        statusTimer = setTimeout(() => setStatus('v' + chrome.runtime.getManifest().version), 1500);
      } catch (e) {
        toast('操作失败：' + e.message);
      }
    });
  }

  init();
})();
