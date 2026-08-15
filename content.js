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
//   3. 注入可拖拽的 UI：收起时是一个圆形悬浮球（可自定义图标
//      样式：速度数字 / ⚡ 闪电 / 🚀 火箭），点击或悬停展开为
//      完整控制面板（Shadow DOM 隔离样式，毛玻璃质感）
//   4. 用 chrome.storage.local 跨页面记忆速度、控件位置与图标样式
// ============================================================
(() => {
  'use strict';

  // ---------- 常量 ----------
  const STORAGE_KEY = 'vspeed';
  const POS_KEY = 'vspeedPos';
  const ICON_KEY = 'vspeedIcon';
  const DEFAULT_SPEED = 1;
  const MIN_SPEED = 0.25;
  const MAX_SPEED = 16; // Chrome 实际会将超出范围的值 clamp 到 16
  const SLIDER_STEP = 0.05;
  const PRESETS = [0.5, 1, 1.5, 2, 2.5, 3, 4, 8];
  const PANEL_WIDTH = 216;
  const BALL_SIZE = 46;
  // 悬浮球图标样式：number=速度数字 / bolt=闪电 / rocket=火箭
  const ICON_STYLES = ['number', 'bolt', 'rocket'];
  const ICON_GLYPH = { number: '', bolt: '⚡', rocket: '🚀' };

  // ---------- 运行状态 ----------
  let currentSpeed = DEFAULT_SPEED; // 当前目标速度（跨页面记忆）
  let video = null;                 // 当前正在控制的 <video> 元素
  let applying = false;             // 是否为"我们自己"改的速度（防 ratechange 回环）
  let ui = null;                    // UI 对象（render 方法）
  let iconStyle = 'bolt';           // 悬浮球图标样式（默认闪电）
  let pinned = false;               // 是否"钉住"展开（点击切换，悬停不自动收起）

  // ============================================================
  // 持久化
  // ============================================================
  async function loadSaved() {
    try {
      const data = await chrome.storage.local.get([STORAGE_KEY, POS_KEY, ICON_KEY]);
      const sp = Number(data[STORAGE_KEY]);
      if (Number.isFinite(sp) && sp >= MIN_SPEED && sp <= MAX_SPEED) {
        currentSpeed = sp;
      }
      if (ICON_STYLES.indexOf(data[ICON_KEY]) !== -1) {
        iconStyle = data[ICON_KEY];
      }
      return data[POS_KEY] || null;
    } catch (err) {
      return null;
    }
  }

  function saveSpeed() {
    try { chrome.storage.local.set({ [STORAGE_KEY]: currentSpeed }); } catch (e) { /* ignore */ }
  }

  function saveIconStyle() {
    try { chrome.storage.local.set({ [ICON_KEY]: iconStyle }); } catch (e) { /* ignore */ }
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
  // UI：悬浮球 + 可展开面板（Shadow DOM 隔离样式）
  // ============================================================
  function fmt(v) {
    return String(Math.round(v * 100) / 100);
  }

  function buildUI(savedPos) {
    const root = document.createElement('div');
    root.className = 'vspeed-root';
    root.setAttribute('data-role', 'vspeed-root');
    root.style.cssText =
      'position:fixed;z-index:2147483647;' +
      'width:' + BALL_SIZE + 'px;height:' + BALL_SIZE + 'px;' +
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

    const styleHtml = ICON_STYLES
      .map((s) => '<button class="style-opt" data-role="style-opt" data-s="' + s + '" title="' + s + '">' +
        (s === 'number' ? '2x' : ICON_GLYPH[s]) + '</button>')
      .join('');

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap {
          position: relative;
          font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
          color: #e8e8e8;
          user-select: none;
        }
        /* ---- 悬浮球 ---- */
        .ball {
          width: ${BALL_SIZE}px;
          height: ${BALL_SIZE}px;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #6a5af9 0%, #4a9eff 100%);
          color: #fff;
          box-shadow: 0 4px 16px rgba(74, 120, 255, 0.55), 0 2px 6px rgba(0, 0, 0, 0.25);
          cursor: pointer;
          transition: transform .18s ease, box-shadow .18s ease;
          box-sizing: border-box;
        }
        .ball:hover {
          transform: scale(1.08);
          box-shadow: 0 6px 22px rgba(74, 120, 255, 0.7), 0 2px 8px rgba(0, 0, 0, 0.3);
        }
        .ball .glyph { font-weight: 700; line-height: 1; }
        .ball .glyph.text { font-size: 15px; letter-spacing: .3px; }
        .ball .glyph.emoji { font-size: 21px; }
        /* ---- 控制面板（毛玻璃） ---- */
        .panel {
          position: absolute;
          top: 0;
          left: 0;
          width: ${PANEL_WIDTH}px;
          background: rgba(24, 26, 32, 0.86);
          -webkit-backdrop-filter: blur(10px) saturate(140%);
          backdrop-filter: blur(10px) saturate(140%);
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 14px;
          color: #e8e8e8;
          box-shadow: 0 10px 32px rgba(0, 0, 0, 0.5);
          overflow: hidden;
          opacity: 0;
          transform: scale(.85) translateY(4px);
          transform-origin: top left;
          pointer-events: none;
          transition: opacity .16s ease, transform .16s ease;
        }
        .wrap.expanded .panel {
          opacity: 1;
          transform: scale(1) translateY(0);
          pointer-events: auto;
        }
        .wrap.expanded .ball { display: none; }
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
          transition: background .12s ease, border-color .12s ease;
        }
        .row button:hover { background: rgba(74, 158, 255, 0.35); border-color: #4a9eff; }
        .row button:active { transform: scale(0.96); }
        /* ---- 球图标样式选择 ---- */
        .style-row {
          display: flex; align-items: center; gap: 6px;
          margin-top: 9px; padding-top: 8px;
          border-top: 1px dashed rgba(255, 255, 255, 0.14);
        }
        .style-row .label { font-size: 11px; color: #999; flex: 1; }
        .style-opt {
          width: 30px; height: 30px;
          border-radius: 50%;
          border: 1px solid rgba(255, 255, 255, 0.18);
          background: rgba(255, 255, 255, 0.07);
          color: #e8e8e8;
          font-size: 13px;
          cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: all .12s ease;
        }
        .style-opt:hover { background: rgba(255, 255, 255, 0.16); }
        .style-opt.active {
          background: rgba(74, 158, 255, 0.4);
          border-color: #4a9eff;
          box-shadow: 0 0 0 2px rgba(74, 158, 255, 0.25);
        }
        .hint { margin-top: 8px; color: #999; font-size: 11px; text-align: center; }
      </style>
      <div class="wrap">
        <div class="ball" data-role="ball" title="视频倍速控制（点击固定展开）">
          <span class="glyph emoji" data-role="ball-icon">⚡</span>
        </div>
        <div class="panel" data-role="panel">
          <div class="header">
            <span class="title">▶ 倍速控制</span>
            <span class="speed" data-role="speed">1x</span>
            <button class="fold" data-role="fold" title="收起">–</button>
          </div>
          <div class="body">
            <input class="slider" type="range" min="0.25" max="16" step="0.05"
                   data-role="slider" aria-label="播放速度">
            <div class="row">${presetHtml}</div>
            <div class="style-row">
              <span class="label">球图标</span>
              ${styleHtml}
            </div>
            <div class="hint">范围 0.25x ~ 16x（可拖拽移动）</div>
          </div>
        </div>
      </div>
    `;

    // ---- DOM 引用 ----
    const $ = (sel) => shadow.querySelector(sel);
    const wrap = $('.wrap');
    const ball = $('[data-role="ball"]');
    const panel = $('[data-role="panel"]');
    const glyph = $('[data-role="ball-icon"]');
    const slider = $('[data-role="slider"]');
    const speedEl = $('[data-role="speed"]');
    const foldBtn = $('[data-role="fold"]');
    const header = $('.header');

    // ---- 展开 / 收起（点击 pin + 悬停两种方式） ----
    let expanded = false;
    function setExpanded(on) {
      expanded = on;
      wrap.classList.toggle('expanded', on);
      root.setAttribute('data-expanded', String(on));
      if (on) {
        // 面板向右展开可能溢出屏幕右缘，必要时向左偏移
        const r = root.getBoundingClientRect();
        const overflow = r.left + PANEL_WIDTH - window.innerWidth;
        panel.style.left = overflow > 0 ? (-overflow - 6) + 'px' : '0px';
      }
    }
    root.setAttribute('data-expanded', String(expanded));

    // ---- 球图标渲染 ----
    function renderIcon() {
      if (iconStyle === 'number') {
        glyph.textContent = fmt(currentSpeed) + 'x';
        glyph.className = 'glyph text';
      } else {
        glyph.textContent = ICON_GLYPH[iconStyle] || ICON_GLYPH.bolt;
        glyph.className = 'glyph emoji';
      }
      shadow.querySelectorAll('[data-role="style-opt"]').forEach((b) => {
        b.classList.toggle('active', b.dataset.s === iconStyle);
      });
      root.setAttribute('data-icon', iconStyle);
    }

    // ---- 交互：悬停展开 / 点击固定 ----
    ball.addEventListener('mouseenter', () => setExpanded(true));
    wrap.addEventListener('mouseleave', () => {
      if (!pinned) setExpanded(false);
    });
    ball.addEventListener('click', () => {
      if (moved) return; // 拖拽后不触发展开
      if (expanded) {
        pinned = false;
        setExpanded(false);
      } else {
        pinned = true;
        setExpanded(true);
      }
    });
    foldBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      pinned = false;
      setExpanded(false);
    });

    // ---- 速度控件 ----
    slider.addEventListener('input', () => applySpeed(parseFloat(slider.value)));
    shadow.querySelectorAll('[data-role="preset"]').forEach((btn) => {
      btn.addEventListener('click', () => applySpeed(parseFloat(btn.dataset.v)));
    });

    // ---- 图标样式切换 ----
    shadow.querySelectorAll('[data-role="style-opt"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        iconStyle = btn.dataset.s;
        saveIconStyle();
        renderIcon();
      });
    });

    // ---- 拖拽（悬浮球 / 面板标题栏），5px 阈值区分点击 ----
    let dragging = false;
    let moved = false;
    let dx = 0;
    let dy = 0;
    const onDown = (e) => {
      if (e.target === foldBtn) return;
      dragging = true;
      moved = false;
      const r = root.getBoundingClientRect();
      dx = e.clientX - r.left;
      dy = e.clientY - r.top;
      e.preventDefault();
    };
    ball.addEventListener('mousedown', onDown);
    header.addEventListener('mousedown', onDown);
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      if (!moved) {
        const cur = root.getBoundingClientRect();
        const dist = Math.abs(e.clientX - dx - cur.left) + Math.abs(e.clientY - dy - cur.top);
        if (dist < 5) return; // 未超过阈值，视为点击
        moved = true;
      }
      const x = Math.min(window.innerWidth - BALL_SIZE, Math.max(0, e.clientX - dx));
      const y = Math.min(window.innerHeight - BALL_SIZE, Math.max(0, e.clientY - dy));
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
        renderIcon();
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
