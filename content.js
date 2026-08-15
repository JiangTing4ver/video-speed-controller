// ============================================================
// 视频倍速控制器 · 内容脚本 (content.js)
// ------------------------------------------------------------
// 运行方式：由 manifest.json 声明，Chrome 在用户打开任意网页时
// 自动把本脚本注入到页面内部，与页面共享 DOM（就像在 F12 控制台
// 里执行一样）。
//
// 职责：
//   1. 找到页面里的 <video> 元素（动态监听 DOM 变化）
//   2. 通过 video.playbackRate 属性控制播放速度（0.25x ~ 16x）
//   3. 注入一个可拖拽的悬浮控制条（Shadow DOM 隔离样式）
//   4. 用 chrome.storage.local 跨页面记忆速度与控件位置
// ============================================================
(() => {
  'use strict';

  // ---------- 常量 ----------
  const STORAGE_KEY = 'vspeed';
  const POS_KEY = 'vspeedPos';
  const DEFAULT_SPEED = 1;
  const MIN_SPEED = 0.25;
  const MAX_SPEED = 16; // Chrome 实际会将超出范围的值 clamp 到 16
  const SLIDER_STEP = 0.05;
  const PRESETS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 8];
  const PANEL_WIDTH = 216;

  // ---------- 运行状态 ----------
  let currentSpeed = DEFAULT_SPEED; // 当前目标速度（跨页面记忆）
  let video = null;                 // 当前正在控制的 <video> 元素
  let applying = false;             // 是否为"我们自己"改的速度（防 ratechange 回环）
  let ui = null;                    // UI 对象（render 方法）

  // ============================================================
  // 持久化
  // ============================================================
  async function loadSaved() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY, POS_KEY]);
      const sp = Number(data[STORAGE_KEY]);
      if (Number.isFinite(sp) && sp >= MIN_SPEED && sp <= MAX_SPEED) {
        currentSpeed = sp;
      }
      return data[POS_KEY] || null;
    } catch (err) {
      return null;
    }
  }

  function saveSpeed() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: currentSpeed }); } catch (e) { /* ignore */ }
  }

  function savePos(left, top) {
    try { chrome.storage.local.set({ [POS_KEY]: { left, top } }); } catch (e) { /* ignore */ }
  }

  // ============================================================
  // 速度控制核心
  // ============================================================
  function clampSpeed(v) {
    return Math.min(MAX_SPEED, Math.max(MIN_SPEED, v));
  }

  // 设置速度：更新状态 -> 持久化 -> 应用到 video -> 刷新 UI
  function applySpeed(raw) {
    currentSpeed = clampSpeed(raw);
    saveSpeed();
    if (video) {
      applying = true;
      try { video.playbackRate = currentSpeed; } catch (e) { /* ignore */ }
      applying = false;
    }
    if (ui) ui.render(currentSpeed);
  }

  // ============================================================
  // 视频元素跟踪
  // ============================================================
  function onMeta() {
    // 切集 / 重新加载时播放器可能重置属性，这里强制再应用一次
    applying = true;
    try { video.playbackRate = currentSpeed; } catch (e) { /* ignore */ }
    applying = false;
  }

  function onRate() {
    // 网页自身（如 B 站倍速菜单）改了速度：同步 UI 与状态，保持一致性
    if (applying || !video) return;
    currentSpeed = clampSpeed(video.playbackRate);
    if (ui) ui.render(currentSpeed);
  }

  function trackVideo(v) {
    if (!v || v === video) return;
    if (video) {
      video.removeEventListener('loadedmetadata', onMeta);
      video.removeEventListener('ratechange', onRate);
    }
    video = v;
    video.addEventListener('loadedmetadata', onMeta);
    video.addEventListener('ratechange', onRate);
    // 立即应用当前速度（属性赋值即时生效，无需媒体源）
    applying = true;
    try { video.playbackRate = currentSpeed; } catch (e) { /* ignore */ }
    applying = false;
    if (ui) ui.render(currentSpeed);
  }

  // 页面可能有多个 video（广告、预览等），选出"当前该控制的那个"：
  // 优先正在播放的；否则取视口内面积最大的。
  function chooseVideo() {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return null;
    const playing = videos.find((v) => !v.paused && !v.ended);
    if (playing) return playing;
    const visible = videos.filter((v) => {
      const r = v.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const pool = visible.length ? visible : videos;
    const area = (v) => v.getBoundingClientRect().width * v.getBoundingClientRect().height;
    return pool.reduce((a, b) => (area(b) > area(a) ? b : a));
  }

  // 持续监听 DOM：视频元素是异步出现的，页面结构一变就重新扫描
  function startWatching() {
    let last = null;
    const scan = () => {
      const v = chooseVideo();
      if (v !== last) {
        last = v;
        trackVideo(v);
      }
    };
    scan();
    const mo = new MutationObserver(() => scan());
    mo.observe(document.documentElement, { childList: true, subtree: true });
  }

  // ============================================================
  // 可视化悬浮控制条（Shadow DOM 隔离样式，避免污染网页）
  // ============================================================
  function fmt(v) {
    return String(Math.round(v * 100) / 100);
  }

  function buildUI(savedPos) {
    const root = document.createElement('div');
    root.className = 'vspeed-root';
    root.setAttribute('data-role', 'vspeed-root');
    root.style.cssText =
      'position:fixed;z-index:2147483647;width:' + PANEL_WIDTH + 'px;' +
      'font-size:12px;';

    if (savedPos) {
      root.style.left = savedPos.left + 'px';
      root.style.top = savedPos.top + 'px';
    } else {
      root.style.right = '20px';
      root.style.bottom = '20px';
    }

    // ---- Shadow DOM：页面 CSS 无法影响控件，控件样式也不会泄漏 ----
    const shadow = root.attachShadow({ mode: 'open' });

    const presetHtml = PRESETS
      .map((p) => '<button data-role="preset" data-v="' + p + '">' + fmt(p) + 'x</button>')
      .join('');

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .panel {
          font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
          background: rgba(24, 26, 32, 0.93);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 10px;
          color: #e8e8e8;
          box-shadow: 0 6px 24px rgba(0, 0, 0, 0.45);
          user-select: none;
          overflow: hidden;
        }
        .header {
          display: flex; align-items: center; gap: 8px;
          padding: 8px 10px;
          cursor: move;
          background: rgba(255, 255, 255, 0.06);
        }
        .title { flex: 1; font-weight: 600; font-size: 12px; }
        .speed {
          font-variant-numeric: tabular-nums;
          color: #6cf; font-weight: 700; min-width: 42px; text-align: right;
        }
        .fold {
          border: 0; background: transparent; color: #ccc; cursor: pointer;
          font-size: 14px; line-height: 1; padding: 2px 6px; border-radius: 4px;
        }
        .fold:hover { background: rgba(255, 255, 255, 0.15); color: #fff; }
        .body { padding: 10px; }
        .slider { width: 100%; accent-color: #4a9eff; cursor: pointer; margin: 0; }
        .row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
        .row button {
          flex: 1 0 21%;
          background: rgba(255, 255, 255, 0.08);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #e8e8e8;
          border-radius: 6px;
          padding: 5px 0;
          cursor: pointer;
          font-size: 12px;
        }
        .row button:hover { background: rgba(74, 158, 255, 0.35); border-color: #4a9eff; }
        .row button:active { transform: scale(0.96); }
        .hint { margin-top: 8px; color: #999; font-size: 11px; text-align: center; }
        .panel.collapsed .body { display: none; }
      </style>
      <div class="panel">
        <div class="header">
          <span class="title">▶ 倍速控制</span>
          <span class="speed" data-role="speed">1x</span>
          <button class="fold" data-role="fold" title="收起 / 展开">–</button>
        </div>
        <div class="body">
          <input class="slider" type="range" min="0.25" max="16" step="0.05"
                 data-role="slider" aria-label="播放速度">
          <div class="row">${presetHtml}</div>
          <div class="hint">范围 0.25x ~ 16x（可拖拽移动）</div>
        </div>
      </div>
    `;

    // ---- 事件绑定 ----
    const $ = (sel) => shadow.querySelector(sel);
    const slider = $('[data-role="slider"]');
    const speedEl = $('[data-role="speed"]');
    const foldBtn = $('[data-role="fold"]');
    const header = $('.header');
    const panel = $('.panel');

    slider.addEventListener('input', () => applySpeed(parseFloat(slider.value)));
    shadow.querySelectorAll('[data-role="preset"]').forEach((btn) => {
      btn.addEventListener('click', () => applySpeed(parseFloat(btn.dataset.v)));
    });

    // 收起 / 展开
    foldBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      panel.classList.toggle('collapsed');
      foldBtn.textContent = panel.classList.contains('collapsed') ? '+' : '–';
    });

    // 拖拽移动（标题栏）
    let dragging = false;
    let dx = 0;
    let dy = 0;
    header.addEventListener('mousedown', (e) => {
      if (e.target === foldBtn) return;
      dragging = true;
      const r = root.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const x = Math.min(window.innerWidth - 30, Math.max(0, e.clientX - dx));
      const y = Math.min(window.innerHeight - 20, Math.max(0, e.clientY - dy));
      root.style.left = x + 'px';
      root.style.top = y + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      savePos(parseFloat(root.style.left) || 0, parseFloat(root.style.top) || 0);
    });

    // ---- UI 接口 ----
    ui = {
      render(speed) {
        speedEl.textContent = fmt(speed) + 'x';
        slider.value = String(speed);
        // 供调试 / 自动化验证：把状态写到根元素属性上
        root.setAttribute('data-speed', String(speed));
        root.setAttribute(
          'data-video-rate',
          video && Number.isFinite(video.playbackRate) ? String(video.playbackRate) : 'none'
        );
      },
    };

    document.body.appendChild(root);
    ui.render(currentSpeed);
  }

  // ============================================================
  // 入口
  // ============================================================
  (async () => {
    const savedPos = await loadSaved();
    buildUI(savedPos);
    startWatching();
  })();
})();
