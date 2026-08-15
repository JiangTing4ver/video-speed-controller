// ============================================================
// 视频倍速控制器 · 选项页逻辑 (options.js)
// ------------------------------------------------------------
// 提供【启用 / 禁用】开关。状态写入 chrome.storage.local，
// content script 监听 storage 变化后即时隐藏 / 恢复悬浮球。
//
// 健壮性处理：
//   1. 写入为异步 API：await 等待完成，写入期间禁用开关防连点，
//      并用请求序号做 latest-wins 竞态防护；
//   2. onChanged 严格过滤：仅响应 storage.local 的 ENABLED_KEY，
//      且 newValue 必须为布尔，UI 状态一致时跳过重绘；
//   3. 状态判断统一：仅显式 false 视为禁用，undefined 视为启用，
//      load() 与 onChanged 使用同一 isEnabled() 判定；
//   4. 页面销毁（popup 关闭）时移除 storage 监听，规范清理；
//   5. 操作反馈：写入成功/失败通过底部提示框短暂提示。
// ============================================================
(() => {
  'use strict';

  const ENABLED_KEY = 'vspeedEnabled';

  const toggle = document.getElementById('enabled-toggle');
  const tipEl = document.getElementById('tip');

  // 版本号从 manifest 动态读取，避免硬编码
  try {
    const manifest = chrome.runtime.getManifest();
    if (manifest && manifest.version) {
      document.getElementById('ver').textContent = 'v' + manifest.version;
    }
  } catch (e) { /* ignore */ }

  // ---- 状态判定统一：仅显式 false 为禁用 ----
  const isEnabled = (v) => v !== false;

  let currentOn = true; // 当前 UI 呈现的状态（供反馈恢复与重绘判断）

  function renderState(on) {
    currentOn = on;
    toggle.checked = on;
    document.body.setAttribute('data-enabled', String(on));
    restoreTip();
  }

  function restoreTip() {
    if (feedbackTimer) clearTimeout(feedbackTimer); // 清掉未触发的反馈定时器
    tipEl.textContent = currentOn
      ? '切换对已打开页面即时生效，无需刷新'
      : '已禁用，重新打开开关即恢复';
    tipEl.className = 'tip-text';
  }

  // ---- 初始加载 ----
  async function load() {
    let on = true; // 默认启用（未设置过时视为启用）
    try {
      const data = await chrome.storage.local.get(ENABLED_KEY);
      on = isEnabled(data[ENABLED_KEY]);
    } catch (e) { /* ignore */ }
    renderState(on);
  }

  // ---- 写入：await + latest-wins 竞态防护 + 操作反馈 ----
  let latestRequest = 0;
  let feedbackTimer = null;

  function flashFeedback(ok, text) {
    tipEl.textContent = text;
    tipEl.className = 'tip-text ' + (ok ? 'feedback-ok' : 'feedback-err');
    if (feedbackTimer) clearTimeout(feedbackTimer);
    feedbackTimer = setTimeout(restoreTip, 1600); // 短暂提示后恢复默认文案
  }

  async function applyState(on) {
    const req = ++latestRequest;
    toggle.disabled = true; // 写入期间禁用开关，杜绝快速连点造成时序错乱
    try {
      await chrome.storage.local.set({ [ENABLED_KEY]: on });
      if (req !== latestRequest) return; // 已被更新的请求覆盖，放弃本次渲染
      renderState(on);
      flashFeedback(true, '✓ 已' + (on ? '启用' : '禁用'));
    } catch (e) {
      if (req !== latestRequest) return;
      renderState(!on); // 写入失败：UI 回滚到实际状态
      flashFeedback(false, '⚠ 保存失败，请重试');
    } finally {
      if (req === latestRequest) toggle.disabled = false;
    }
  }

  toggle.addEventListener('change', () => applyState(toggle.checked));

  // ---- onChanged：严格过滤 + 状态一致跳过重绘 ----
  const onStorageChanged = (changes, area) => {
    if (area !== 'local') return;
    const ch = changes[ENABLED_KEY];
    if (!ch || typeof ch.newValue !== 'boolean') return; // 忽略 undefined/非布尔
    if (ch.newValue === toggle.checked) return;          // 与当前 UI 一致，无需重绘
    renderState(isEnabled(ch.newValue));
  };
  chrome.storage.onChanged.addListener(onStorageChanged);

  // ---- 页面生命周期：销毁时移除监听；重新显示（tab 切回/popup 重开）时重注册并同步 ----
  let registered = false;
  function registerListener() {
    if (registered) return;
    registered = true;
    chrome.storage.onChanged.addListener(onStorageChanged);
  }
  function unregisterListener() {
    if (!registered) return;
    registered = false;
    try { chrome.storage.onChanged.removeListener(onStorageChanged); } catch (e) { /* ignore */ }
  }
  window.addEventListener('pageshow', () => {
    registerListener();
    load(); // 切回页面时重新同步最新状态（如其他 popup 已改动）
  });
  window.addEventListener('pagehide', unregisterListener);

  registerListener();
  load();
})();
