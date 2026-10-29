// keys-page.mjs — API Key 管理页（服务端渲染单文件，版式对齐 dsh-web-service api-keys-page）
// 设计令牌取自 dsh-web-service page-theme.ts（HARNESS 浅色默认 + data-ds-dark-theme 深色覆盖）。
// 安全约定：页面本身不含密钥；数据全走 /api-keys*；本机（回环）访问免管理令牌直接管理，
// 远程（adminRemoteAccess 放开）时接口返回 401，页面才弹出管理令牌闸门；令牌只存 localStorage；
// 新建/轮换成功后一次性弹层展示完整 Key，关闭即从 DOM 清除；列表「复制」走 reveal 现取现用。

export function generateApiKeysHtml(prefix, adminTokenPath = '', embed = false, serviceVersion = '0.2.0') {
  const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]))
  const base = escapeHtml(prefix)
  const jsBase = JSON.stringify(prefix)
  const tokenPath = escapeHtml(adminTokenPath || '~/.zcode/zcode-web-service/admin-token')
  const jsTokenPath = JSON.stringify(adminTokenPath || '~/.zcode/zcode-web-service/admin-token')
  const version = escapeHtml(serviceVersion)

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>API Key 管理 · ZCode Web Service</title>
  <style>
    /* ---- HARNESS 设计令牌（镜像 dsh-web-service page-theme.ts）---- */
    :root {
      --dsw-alias-bg-base: rgb(255, 255, 255);
      --dsw-alias-bg-layer-1: rgb(255, 255, 255);
      --dsw-alias-bg-layer-2: rgb(255, 255, 255);
      --dsw-alias-bg-overlay: rgb(233, 236, 242);
      --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.24);
      --dsw-specific-input-major: rgb(255, 255, 255);
      --dsw-alias-border-l1: rgba(0, 0, 0, 0.04);
      --dsw-alias-border-l2: rgba(0, 0, 0, 0.10);
      --dsw-alias-border-l3: rgba(0, 0, 0, 0.12);
      --dsw-alias-label-primary: rgb(15, 17, 21);
      --dsw-alias-label-secondary: rgb(97, 102, 107);
      --dsw-alias-label-tertiary: rgb(129, 133, 140);
      --dsw-alias-label-caption: rgb(173, 178, 184);
      --dsw-alias-label-primary-foreground: rgb(255, 255, 255);
      --dsw-alias-button-primary-fill: rgb(15, 17, 21);
      --dsw-alias-button-primary-hover: rgb(67, 69, 74);
      --dsw-alias-interactive-bg-hover: rgba(38, 49, 72, 0.06);
      --dsw-alias-interactive-bg-hover-solid: rgb(241, 243, 245);
      --dsw-alias-interactive-bg-hover-danger: rgba(236, 19, 19, 0.05);
      --dsw-alias-link: rgb(65, 118, 230);
      --dsw-alias-state-error-primary: rgb(236, 19, 19);
      --dsw-alias-state-error-secondary: rgb(242, 90, 90);
      --dsw-alias-state-success-primary: rgb(34, 197, 94);
      --dsw-alias-state-success-tertiary: rgb(230, 250, 237);
      --dsw-alias-state-warn-label: rgb(221, 134, 41);
      --dsw-alias-state-warn-tertiary: rgb(254, 245, 231);
      --dsw-alias-state-business-primary: rgb(65, 118, 230);
      --dsw-alias-state-business-tertiary: rgb(228, 237, 253);
      --dsw-alias-toast-bg: rgb(53, 54, 56);
      --dsw-alias-markdown-code-block: rgb(250, 250, 250);
      --dsw-alias-markdown-inline-code: rgb(245, 245, 245);
      --dsw-alias-scrollbar-bg-l1: rgb(229, 229, 229);
      --dsw-alias-scrollbar-hover-l1: rgb(212, 212, 212);
      --dsw-font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
      --ds-font-family-code: 'SF Mono', 'JetBrains Mono', 'Fira Code', Consolas, 'Liberation Mono', Menlo, Courier, 'PingFang SC', 'Microsoft YaHei';
      --ds-ease-in-out: cubic-bezier(0.4, 0, 0.2, 1);
      --ds-transition-duration: 0.2s;
      --ds-transition-duration-fast: 0.1s;
    }
    html[data-ds-dark-theme] {
      --dsw-alias-bg-base: rgb(21, 21, 23);
      --dsw-alias-bg-layer-1: rgb(35, 35, 36);
      --dsw-alias-bg-layer-2: rgb(44, 44, 46);
      --dsw-alias-bg-overlay: rgb(97, 102, 107);
      --dsw-alias-bg-mask-1: rgba(0, 0, 0, 0.5);
      --dsw-specific-input-major: rgb(44, 44, 46);
      --dsw-alias-border-l1: rgba(255, 255, 255, 0.06);
      --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
      --dsw-alias-border-l3: rgba(255, 255, 255, 0.16);
      --dsw-alias-label-primary: rgb(249, 250, 251);
      --dsw-alias-label-secondary: rgb(207, 211, 214);
      --dsw-alias-label-tertiary: rgb(173, 178, 184);
      --dsw-alias-label-caption: rgb(129, 133, 140);
      --dsw-alias-label-primary-foreground: rgb(15, 17, 21);
      --dsw-alias-button-primary-fill: rgb(249, 250, 251);
      --dsw-alias-button-primary-hover: rgb(235, 238, 242);
      --dsw-alias-interactive-bg-hover: rgba(255, 255, 255, 0.08);
      --dsw-alias-interactive-bg-hover-solid: rgb(53, 54, 56);
      --dsw-alias-interactive-bg-hover-danger: rgba(242, 90, 90, 0.15);
      --dsw-alias-link: rgb(103, 158, 254);
      --dsw-alias-state-error-primary: rgb(242, 90, 90);
      --dsw-alias-state-error-secondary: rgb(242, 90, 90);
      --dsw-alias-state-success-primary: rgb(34, 197, 94);
      --dsw-alias-state-success-tertiary: rgb(35, 60, 44);
      --dsw-alias-state-warn-label: rgb(221, 134, 41);
      --dsw-alias-state-warn-tertiary: rgb(39, 36, 31);
      --dsw-alias-state-business-primary: rgb(103, 158, 254);
      --dsw-alias-state-business-tertiary: rgb(52, 65, 91);
      --dsw-alias-toast-bg: rgb(67, 69, 74);
      --dsw-alias-markdown-code-block: rgb(27, 27, 28);
      --dsw-alias-markdown-inline-code: rgb(41, 41, 41);
      --dsw-alias-scrollbar-bg-l1: rgb(60, 60, 61);
      --dsw-alias-scrollbar-hover-l1: rgb(84, 85, 87);
    }

    /* ---- 通用控件皮肤（镜像 dsh HARNESS_PRIMITIVES_CSS）---- */
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 24px;
      font-family: var(--dsw-font-family); font-size: 14px; line-height: 1.5;
      color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base);
      -webkit-font-smoothing: antialiased;
    }
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: var(--dsw-alias-scrollbar-bg-l1); border-radius: 999px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-scrollbar-hover-l1); }
    .container { max-width: 1100px; margin: 0 auto; }
    .page-header {
      margin-bottom: 20px; padding-bottom: 16px;
      border-bottom: 1px solid var(--dsw-alias-border-l1);
      display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap;
    }
    h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.01em; }
    h2 { font-size: 15px; font-weight: 600; color: var(--dsw-alias-label-primary); }
    .subtitle { color: var(--dsw-alias-label-secondary); font-size: 13.5px; margin-top: 6px; }
    .section-title { font-size: 16px; font-weight: 600; margin: 26px 0 12px; display: flex; align-items: center; gap: 8px; }
    .muted { color: var(--dsw-alias-label-secondary); font-size: 13px; }
    .version-tag {
      font-size: 12px; font-weight: 500; color: var(--dsw-alias-label-secondary);
      background: var(--dsw-alias-interactive-bg-hover-solid);
      border: 1px solid var(--dsw-alias-border-l1);
      border-radius: 999px; padding: 2px 10px; vertical-align: middle; margin-left: 8px;
    }
    .btn {
      appearance: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      font-family: inherit; font-size: 13.5px; font-weight: 500; line-height: 1;
      padding: 8px 14px; border-radius: 8px; border: 1px solid transparent; cursor: pointer;
      text-decoration: none; white-space: nowrap;
      background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground);
      transition: background var(--ds-transition-duration) var(--ds-ease-in-out), opacity var(--ds-transition-duration-fast) linear;
    }
    .btn:hover { background: var(--dsw-alias-button-primary-hover); }
    .btn:active { opacity: 0.88; }
    .btn:disabled { opacity: 0.45; cursor: not-allowed; }
    .btn:focus-visible { outline: 2px solid var(--dsw-alias-link); outline-offset: 2px; }
    .btn-ghost { background: transparent; color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
    .btn-ghost:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .btn-danger { background: var(--dsw-alias-state-error-primary); color: #fff; }
    .btn-danger:hover { background: var(--dsw-alias-state-error-secondary); }
    .btn-sm { padding: 5px 10px; font-size: 12.5px; border-radius: 6px; }
    .card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; padding: 16px; }
    .field { margin-bottom: 14px; }
    .field-label { display: block; font-size: 12.5px; color: var(--dsw-alias-label-secondary); margin-bottom: 5px; }
    input[type="text"], input[type="password"], select {
      width: 100%; background: var(--dsw-specific-input-major);
      border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary);
      padding: 8px 12px; border-radius: 8px; font-size: 13.5px; font-family: inherit;
    }
    input::placeholder { color: var(--dsw-alias-label-caption); }
    input:focus-visible, select:focus-visible {
      outline: none; border-color: var(--dsw-alias-link);
      box-shadow: 0 0 0 3px var(--dsw-alias-state-business-tertiary);
    }
    .field-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); margin-top: 4px; }
    .field-error { font-size: 12.5px; color: var(--dsw-alias-state-error-primary); margin-top: 4px; }
    .input-invalid { border-color: var(--dsw-alias-state-error-primary) !important; }
    .badge { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 500; line-height: 1.6; }
    .badge-active { background: var(--dsw-alias-state-success-tertiary); color: var(--dsw-alias-state-success-primary); }
    .badge-off { background: var(--dsw-alias-state-warn-tertiary); color: var(--dsw-alias-state-warn-label); }
    .badge-revoked { background: var(--dsw-alias-interactive-bg-hover-solid); color: var(--dsw-alias-label-secondary); }
    .badge-config { background: var(--dsw-alias-state-business-tertiary); color: var(--dsw-alias-state-business-primary); }
    .alert {
      border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; font-size: 13.5px;
      border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2);
      display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap;
    }
    .alert strong { display: block; margin-bottom: 2px; font-weight: 600; }
    .alert-warn { background: var(--dsw-alias-state-warn-tertiary); border-color: transparent; }
    .alert-danger { background: var(--dsw-alias-interactive-bg-hover-danger); border-color: var(--dsw-alias-state-error-primary); }
    table.key-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .key-table th, .key-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1); vertical-align: middle; }
    .key-table th { color: var(--dsw-alias-label-secondary); font-size: 12px; font-weight: 500; }
    .key-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
    .key-table tr:last-child td { border-bottom: none; }
    .key-table .cell-actions { text-align: right; white-space: nowrap; }
    .key-masked { font-family: var(--ds-font-family-code); font-size: 12.5px; }
    .row-revoked { opacity: 0.5; }
    .row-highlight { animation: row-hl 1.8s var(--ds-ease-in-out); }
    @keyframes row-hl { from { background: var(--dsw-alias-state-business-tertiary); } to { background: transparent; } }
    .mono, code, kbd, samp { font-family: var(--ds-font-family-code); }
    code.inline {
      background: var(--dsw-alias-markdown-inline-code);
      border: 1px solid var(--dsw-alias-border-l1);
      border-radius: 6px; padding: 1px 6px; font-size: 12.5px;
    }
    .code-block, .reveal-box {
      background: var(--dsw-alias-markdown-code-block);
      border: 1px solid var(--dsw-alias-border-l1);
      border-radius: 8px; padding: 12px;
      font-family: var(--ds-font-family-code); font-size: 12.5px;
      white-space: pre-wrap; word-break: break-all;
    }
    dialog {
      border: 1px solid var(--dsw-alias-border-l2);
      background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
      border-radius: 12px; padding: 0; width: min(560px, calc(100vw - 32px));
      box-shadow: 0 24px 64px rgba(0, 0, 0, 0.28);
    }
    dialog::backdrop { background: var(--dsw-alias-bg-mask-1); }
    .modal-head { padding: 16px 20px; border-bottom: 1px solid var(--dsw-alias-border-l1); font-size: 15px; font-weight: 600; }
    .modal-body { padding: 20px; }
    .modal-foot { padding: 14px 20px; border-top: 1px solid var(--dsw-alias-border-l1); display: flex; gap: 10px; justify-content: flex-end; flex-wrap: wrap; }
    #toast {
      position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%) translateY(6px);
      background: var(--dsw-alias-toast-bg); color: #fff;
      border-radius: 10px; padding: 10px 16px; font-size: 13.5px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
      opacity: 0; pointer-events: none; z-index: 60;
      transition: opacity var(--ds-transition-duration) var(--ds-ease-in-out), transform var(--ds-transition-duration) var(--ds-ease-in-out);
    }
    #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }

    /* 本页独有布局 */
    .status-row { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
    .empty { text-align: center; padding: 34px 20px; }
    .empty ol { text-align: left; display: inline-block; margin: 12px auto; color: var(--dsw-alias-label-secondary); font-size: 13px; }
    .empty li { margin: 4px 0; }
    .switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; font-size: 13.5px; }
    .sync-icon { display: inline-flex; }
    body[data-embed] { padding: 16px 18px 20px; }
    body[data-embed] h1 { font-size: 18px; }
    @media (max-width: 768px) {
      body { padding: 14px; }
      .key-table thead { display: none; }
      .key-table tr { display: block; border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; margin-bottom: 10px; padding: 6px 4px; }
      .key-table td { display: flex; justify-content: space-between; gap: 12px; border-bottom: none; padding: 6px 10px; }
      .key-table tbody tr:hover { background: transparent; }
      .key-table td::before { content: attr(data-label); color: var(--dsw-alias-label-secondary); font-size: 12px; flex: 0 0 auto; }
    }
    @media (max-width: 480px) {
      .page-header { align-items: flex-start; }
      .modal-foot .btn { width: 100%; }
    }
  </style>
  <script>
    /* 主题同步：内嵌同源 iframe 时镜像父文档令牌；独立打开按 prefers-color-scheme，?theme=light|dark 可强制 */
    (function () {
      var root = document.documentElement;
      var embedded = false;
      try { embedded = window.self !== window.top; } catch (err) { embedded = true; }
      if (embedded) root.setAttribute('data-embedded', '');
      function setDark(on) {
        if (on) root.setAttribute('data-ds-dark-theme', '');
        else root.removeAttribute('data-ds-dark-theme');
      }
      function followSystem() {
        var forced = null;
        try { forced = new URLSearchParams(location.search).get('theme'); } catch (err) {}
        if (forced === 'light' || forced === 'dark') { setDark(forced === 'dark'); return; }
        var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
        function sync() { setDark(!!(mq && mq.matches)); }
        sync();
        if (mq) {
          if (mq.addEventListener) mq.addEventListener('change', sync);
          else if (mq.addListener) mq.addListener(sync);
        }
      }
      followSystem();
    })();
  </script>
</head>
<body${embed ? ' data-embed="1"' : ''}>
  <div class="container">
    <header class="page-header">
      <div>
        <h1>API Key 管理 <span class="version-tag">v${version}</span></h1>
        <div class="subtitle">在此管理第三方程序调用 ZCode API 时使用的访问密钥 &bull; 基础前缀 <code class="inline">${base}</code></div>
      </div>
      <div style="display:flex; gap:10px; flex-wrap:wrap;">
        <a href="${base}/docs/reference" target="_blank" rel="noopener noreferrer" class="btn btn-ghost" style="text-decoration:none;"><span>&lt;&gt; SWAGGER</span></a>
        <button class="btn btn-ghost" onclick="checkUpdate(this)"><span>⟳ 检查更新</span></button>
        <button class="btn" id="btnCreate" style="display:none;" onclick="openCreate()">＋ 新建 API Key</button>
      </div>
    </header>

    <div id="bannerSlot"></div>

    <!-- 管理令牌闸门（仅远程访问触发：接口返回 401 时才显示；本机访问不出现） -->
    <section id="gateCard" class="card" style="display:none;">
      <h2 style="font-size:16px; margin-bottom:8px;">需要管理令牌（Admin Token）</h2>
      <p class="muted" style="margin-bottom:14px;">
        你正在<strong>远程</strong>管理密钥：为避免网络上任何人都能增发/吊销密钥，远程访问需要校验管理令牌；
        在<strong>运行本服务的那台机器</strong>上打开本页面则无需令牌。
      </p>
      <div class="field" style="max-width:520px;">
        <label class="field-label" for="adminTokenInput">管理令牌</label>
        <input type="password" id="adminTokenInput" autocomplete="current-password"
               placeholder="粘贴管理令牌" aria-describedby="adminTokenHint">
        <div class="field-hint" id="adminTokenHint">
          首次启动时由服务自动生成（权限 0600）。在<strong>运行本服务的那台机器</strong>上执行：
          <code class="inline">cat ${tokenPath}</code>
          然后把输出粘贴到上面。令牌会保存在本浏览器的 localStorage 中，公用电脑用完请清除。
        </div>
      </div>
      <button class="btn" onclick="saveAdminToken()">保存并进入</button>
    </section>

    <!-- 主体 -->
    <div id="main" style="display:none;">
      <div class="section-title">1. 鉴权状态</div>
      <div class="card">
        <div class="status-row">
          <span id="authBadge" class="badge">加载中…</span>
          <span class="muted" id="authSummary"></span>
          <span style="margin-left:auto; display:flex; gap:10px; align-items:center;">
            <label class="switch">
              <input type="checkbox" id="authToggle" onchange="onAuthToggle(this)">
              <span id="authToggleLabel">启用鉴权</span>
            </label>
          </span>
        </div>
        <div id="svcAddr" style="margin-top:12px; font-size:13px; display:none;">
          <span class="muted">当前访问的服务地址：</span>
          <code class="inline" id="svcAddrCurrent"></code>
          <span class="muted" id="svcAddrMore" style="display:none;"></span>
        </div>
        <p class="muted" style="margin-top:12px;">
          关闭鉴权后，任何能访问本服务端口的程序都无需 Key 即可调用全部接口（含文件读写、会话操作）。
          已生成的 Key 仍然有效，但不再校验。
        </p>
      </div>

      <div class="section-title">2. API Keys
        <label class="switch" style="margin-left:auto; font-size:13px;">
          <input type="checkbox" id="hideRevoked" onchange="boot()">
          <span>隐藏已吊销</span>
        </label>
      </div>
      <div class="card" style="padding:0; overflow:hidden;">
        <table class="key-table" id="keyTable" style="display:none;">
          <thead>
            <tr>
              <th scope="col">名称</th>
              <th scope="col">密钥（脱敏）</th>
              <th scope="col">创建时间</th>
              <th scope="col">最近使用</th>
              <th scope="col">状态</th>
              <th scope="col">操作</th>
            </tr>
          </thead>
          <tbody id="keyTbody"></tbody>
        </table>
        <div id="keyEmpty" class="empty" style="display:none;">
          <div style="font-size:15px; margin-bottom:6px;">还没有任何 API Key</div>
          <ol>
            <li>点击右上角「新建 API Key」生成密钥</li>
            <li>复制并保存到安全的地方（之后也可在列表里随时复制）</li>
            <li>在客户端请求头里带上 <code class="inline">Authorization: Bearer &lt;key&gt;</code></li>
          </ol>
          <button class="btn" onclick="openCreate()">生成第一条 Key</button>
        </div>
        <div id="keyLoading" class="empty muted">加载中…</div>
      </div>

      <div class="section-title">3. 如何在客户端使用</div>
      <div class="card">
        <p class="muted" style="margin-bottom:10px;">
          客户端请求需携带以下任一请求头。把 <code class="inline">&lt;key&gt;</code> 换成刚生成的完整密钥：
        </p>
        <div class="code-block" id="curlBox"></div>
        <div style="margin-top:12px;">
          <button class="btn btn-ghost btn-sm" onclick="copyCurl()">复制 curl 示例</button>
        </div>
        <p class="muted" style="margin-top:14px;">
          密钥明文可随时在列表里「复制」（现取现用，列表中只展示脱敏形式）。
          若密钥泄露，请立即吊销或轮换。
        </p>
      </div>
    </div>
  </div>

  <!-- 新建 -->
  <dialog id="dlgCreate" aria-labelledby="dlgCreateTitle">
    <div class="modal-head" id="dlgCreateTitle">新建 API Key</div>
    <div class="modal-body">
      <div class="field">
        <label class="field-label" for="fName">名称 <span style="color:#fca5a5;">*</span></label>
        <input type="text" id="fName" maxlength="64" placeholder="例如 py-client-prod">
        <div class="field-hint">仅用于识别，可随时修改（1-64 字符）。</div>
        <div class="field-error" id="fNameError" style="display:none;"></div>
      </div>
      <div class="field">
        <label class="field-label" for="fKeyMode">Key 值</label>
        <select id="fKeyMode" onchange="onKeyModeChange()">
          <option value="random">随机生成（推荐 · 192 位熵）</option>
          <option value="custom">使用自定义 Key（粘贴已有 Key）</option>
        </select>
        <div class="field-hint" id="fKeyModeHint">由本服务生成随机值，强度有保证。</div>
      </div>
      <div class="field" id="fCustomWrap" style="display:none;">
        <label class="field-label" for="fCustomKey">Key 值 <span style="color:#fca5a5;">*</span></label>
        <input type="password" id="fCustomKey" autocomplete="new-password" placeholder="粘贴完整 Key（16-256 个可见 ASCII 字符）">
        <div class="field-hint" id="fCustomKeyHint">
          自定义 Key 的强度取决于你选的值：常见词、生日、短语容易被字典猜中，建议 ≥24 位随机字符。
        </div>
        <div class="field-error" id="fCustomKeyError" style="display:none;"></div>
      </div>
      <div class="field">
        <label class="field-label" for="fNote">备注</label>
        <input type="text" id="fNote" maxlength="256" placeholder="选填">
      </div>
      <div class="field">
        <label class="field-label" for="fExpire">过期时间</label>
        <select id="fExpire">
          <option value="">永不过期</option>
          <option value="7">7 天后</option>
          <option value="30">30 天后</option>
          <option value="90">90 天后</option>
          <option value="365">365 天后</option>
        </select>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgCreate')">取消</button>
      <button class="btn" id="btnCreateSubmit" onclick="submitCreate()">生成</button>
    </div>
  </dialog>

  <!-- 一次性展示 -->
  <dialog id="dlgReveal" aria-labelledby="dlgRevealTitle" role="alertdialog">
    <div class="modal-head" id="dlgRevealTitle">请立即保存完整 Key</div>
    <div class="modal-body">
      <div class="alert alert-warn" style="margin-bottom:14px;">
        <div id="revealHint"><strong>完整 Key</strong>关闭后列表里仍可随时「复制」，但请尽快存到安全的地方。</div>
      </div>
      <div class="reveal-box" id="revealBox" tabindex="0" aria-label="完整 API Key"></div>
      <div style="margin-top:14px;">
        <button class="btn" id="btnCopyKey" onclick="copyReveal()">复制 Key</button>
      </div>
      <p class="muted" style="margin-top:12px;">
        下一步：把 Key 配置到客户端的 <code class="inline">Authorization: Bearer &lt;key&gt;</code> 头，并用页面底部的 curl 验证连通。
      </p>
    </div>
    <div class="modal-foot">
      <button class="btn" id="btnRevealDone" onclick="closeReveal()">我已保存，关闭</button>
    </div>
  </dialog>

  <!-- 改名 -->
  <dialog id="dlgRename" aria-labelledby="dlgRenameTitle">
    <div class="modal-head" id="dlgRenameTitle">重命名</div>
    <div class="modal-body">
      <div class="field">
        <label class="field-label" for="fRename">名称</label>
        <input type="text" id="fRename" maxlength="64">
      </div>
      <div class="field">
        <label class="field-label" for="fRenameNote">备注</label>
        <input type="text" id="fRenameNote" maxlength="256">
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgRename')">取消</button>
      <button class="btn" onclick="submitRename()">保存</button>
    </div>
  </dialog>

  <!-- 轮换 -->
  <dialog id="dlgRotate" aria-labelledby="dlgRotateTitle">
    <div class="modal-head" id="dlgRotateTitle">轮换 Key</div>
    <div class="modal-body">
      <div class="alert alert-warn">
        <div>
          <strong>旧 Key 将立即失效</strong>
          所有正在使用该 Key 的客户端会同时收到 401。新 Key 可在列表里复制。
        </div>
      </div>
      <p class="muted">
        更稳妥的做法是：先「新建」一条替代 Key 并分发，确认客户端切换完成后再「吊销」旧 Key。
      </p>
      <div class="field" style="margin-top:14px;">
        <label class="field-label" for="fRotateName">确认名称</label>
        <input type="text" id="fRotateName" placeholder="输入 Key 名称以确认">
        <div class="field-hint">目标：<strong id="rotateTargetName"></strong></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgRotate')">取消</button>
      <button class="btn btn-danger" id="btnRotateSubmit" onclick="submitRotate()" disabled>仍要立即轮换</button>
    </div>
  </dialog>

  <!-- 吊销 -->
  <dialog id="dlgRevoke" aria-labelledby="dlgRevokeTitle">
    <div class="modal-head" id="dlgRevokeTitle">吊销 Key</div>
    <div class="modal-body">
      <div class="alert alert-danger">
        <div>
          <strong>此操作无法撤销</strong>
          吊销后，使用此 Key 的所有客户端会立即收到 401，需要重新生成 Key 才能恢复。
        </div>
      </div>
      <div class="field" style="margin-top:14px;">
        <label class="field-label" for="fRevokeName">输入 Key 名称以确认</label>
        <input type="text" id="fRevokeName" placeholder="输入 Key 名称以确认">
        <div class="field-hint">目标：<strong id="revokeTargetName"></strong></div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgRevoke')">取消</button>
      <button class="btn btn-danger" id="btnRevokeSubmit" onclick="submitRevoke()" disabled>确认吊销</button>
    </div>
  </dialog>

  <!-- 删除已吊销记录 -->
  <dialog id="dlgDelete" aria-labelledby="dlgDeleteTitle">
    <div class="modal-head" id="dlgDeleteTitle">删除记录</div>
    <div class="modal-body">
      <div class="alert alert-danger">
        <div>
          <strong>将从列表中永久移除该记录</strong>
          目标：<strong id="deleteTargetName"></strong>
          <span class="key-masked" id="deleteTargetMasked"></span>。<br>
          该 Key 已吊销、本来就不可用；删除只是清理记录，操作无法撤销。
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <button class="btn btn-ghost" onclick="closeDialog('dlgDelete')">取消</button>
      <button class="btn btn-danger" id="btnDeleteSubmit" onclick="submitDelete()">确认删除</button>
    </div>
  </dialog>

  <!-- 检查更新 -->
  <dialog id="dlgUpdate" aria-labelledby="dlgUpdateTitle">
    <div class="modal-head" id="dlgUpdateTitle">检查更新</div>
    <div class="modal-body">
      <div id="updateResult" style="white-space:pre-wrap; line-height:1.8;">正在检查更新…</div>
    </div>
    <div class="modal-foot">
      <button class="btn" onclick="closeDialog('dlgUpdate')">关闭</button>
    </div>
  </dialog>

  <div id="toast" role="status" aria-live="polite"></div>

  <script>
    'use strict';
    var BASE = ${jsBase};
    var TOKEN_PATH = ${jsTokenPath};
    var TOKEN_KEY = 'zws_admin_token';
    var TOKEN = localStorage.getItem(TOKEN_KEY) || '';
    var AUTHED = false;
    var KEY_CACHE = [];
    var currentTargetId = null;

    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function fmtTime(ts) {
      if (!ts) return '—';
      var d = new Date(ts);
      return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0') + ' ' + String(d.getHours()).padStart(2, '0') + ':' +
        String(d.getMinutes()).padStart(2, '0');
    }
    function toast(msg) {
      var el = document.getElementById('toast');
      el.textContent = msg;
      el.classList.add('show');
      clearTimeout(el._t);
      el._t = setTimeout(function () { el.classList.remove('show'); }, 3000);
    }
    function closeDialog(id) {
      var d = document.getElementById(id);
      if (d && d.open) d.close();
    }

    async function api(path, options) {
      var opts = options || {};
      var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      if (TOKEN) headers['X-Admin-Token'] = TOKEN;
      var res = await fetch(BASE + path, {
        method: opts.method || 'GET',
        headers: headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        cache: 'no-store',
      });
      var payload = null;
      try { payload = await res.json(); } catch (e) { payload = null; }
      var r = { status: res.status, body: payload };
      if (r.status === 401 || r.status === 403 || r.status === 429) {
        AUTHED = false;
        showGate(true);
        var reason = r.status === 429
          ? '失败次数过多，被临时限流；请等待约 60 秒后再试。'
          : esc((r.body && r.body.error) || ('HTTP ' + r.status));
        banner('warn', '<strong>需要管理令牌</strong>远程管理需校验管理令牌：' + reason +
          '<br>获取命令（在运行本服务的那台机器上执行）：<code class="inline">cat ' + esc(TOKEN_PATH) + '</code>' +
          ' &nbsp;<button class="btn btn-ghost btn-sm" onclick="focusTokenInput()">去输入管理令牌</button>');
      }
      return r;
    }

    function isAuthFail(r) { return r.status === 401 || r.status === 403 || r.status === 429; }

    function saveAdminToken() {
      var v = document.getElementById('adminTokenInput').value.trim();
      if (!v) { toast('请输入管理令牌'); return; }
      TOKEN = v;
      localStorage.setItem(TOKEN_KEY, v);
      boot();
    }
    function focusTokenInput() {
      var el = document.getElementById('adminTokenInput');
      if (el) el.focus();
    }
    function requireAuth() {
      if (AUTHED) return true;
      boot();
      toast('正在加载密钥列表，请稍候…');
      return false;
    }
    function showGate(show) {
      document.getElementById('gateCard').style.display = show ? '' : 'none';
      document.getElementById('main').style.display = show ? 'none' : '';
      var btn = document.getElementById('btnCreate');
      if (btn) btn.style.display = show ? 'none' : '';
    }
    function banner(kind, html) {
      document.getElementById('bannerSlot').innerHTML = '<div class="alert alert-' + kind + '"><div>' + html + '</div></div>';
    }

    async function boot() {
      var hideEl = document.getElementById('hideRevoked');
      var includeRevoked = hideEl && hideEl.checked ? 'false' : 'true';
      var r = await api('/api-keys?includeRevoked=' + includeRevoked);
      if (isAuthFail(r)) return;
      if (r.status !== 200 || !r.body || !r.body.ok) {
        showGate(false);
        banner('danger', '<strong>加载失败</strong>' + esc((r.body && r.body.error) || ('HTTP ' + r.status)) +
          ' &nbsp;<button class="btn btn-ghost btn-sm" onclick="boot()">重试</button>');
        return;
      }
      AUTHED = true;
      showGate(false);
      KEY_CACHE = (r.body.data && r.body.data.keys) || [];
      renderAuth(r.body.data || {});
      renderKeys();
      renderCurl();
      loadServiceAddr();
    }

    // 服务地址展示（对齐 dsh v0.3.8）：先显示当前访问地址，再尽力补上 /api-keys/service
    // 返回的完整地址列表（bind 0.0.0.0 时含局域网地址）。远程无令牌时 401，静默跳过补充部分。
    async function loadServiceAddr() {
      var box = document.getElementById('svcAddr');
      if (!box) return;
      var current;
      try { current = location.origin + BASE; } catch (err) { current = BASE; }
      document.getElementById('svcAddrCurrent').textContent = current;
      box.style.display = '';
      try {
        var r = await api('/api-keys/service');
        if (!r.ok || r.status !== 200 || !r.body || !r.body.ok) return;
        var urls = (r.body.data && r.body.data.urls) || [];
        var others = urls.filter(function (u) { return u !== current; });
        var more = document.getElementById('svcAddrMore');
        if (others.length) {
          more.innerHTML = ' · 其他可达地址：<code class="inline">' + others.map(esc).join('</code> <code class="inline">') + '</code>';
          more.style.display = '';
        }
      } catch (err) { /* 尽力而为 */ }
    }

    function renderAuth(data) {
      var on = !!data.authEnabled;
      var badge = document.getElementById('authBadge');
      badge.textContent = on ? '鉴权已开启' : '鉴权未开启';
      badge.className = 'badge ' + (on ? 'badge-active' : 'badge-off');
      var active = data.activeKeyCount || 0;
      document.getElementById('authSummary').textContent =
        (on ? ('当前 ' + active + ' 条有效 Key') : ('API 无鉴权保护，任何人可调用')) +
        (data.authEnforcedByConfig ? ' · 由插件配置 apiKey 强制开启' : '');
      var toggle = document.getElementById('authToggle');
      toggle.checked = on;
      toggle.disabled = !!data.authEnforcedByConfig;
      document.getElementById('authToggleLabel').textContent = data.authEnforcedByConfig
        ? '启用鉴权（配置强制，不可关闭）'
        : '启用鉴权';

      document.getElementById('bannerSlot').innerHTML = '';
      if (data.storeDegraded) {
        banner('danger', '<strong>密钥存储降级</strong>' + esc(data.storeDegradedReason || '') + ' 请尽快检查服务数据目录下的 api-keys.json 文件。');
      } else if (!on) {
        banner('danger', '<strong>当前 API 无鉴权保护</strong>任何能访问本服务端口的程序都可调用全部接口（含文件读写、会话操作）。建议开启鉴权。');
      } else if (active === 0 && !data.authEnforcedByConfig) {
        banner('danger', '<strong>鉴权已开启，但没有有效的 Key</strong>所有 API 请求都会被拒绝（返回 401）。请生成一条 Key，或暂时关闭鉴权。');
      }
    }

    function onAuthToggle(input) {
      var enable = input.checked;
      if (!enable) {
        var ok = window.confirm(
          '关闭 API 鉴权？\\n\\n' +
          '关闭后，任何能访问本服务端口的程序都无需 Key 即可调用全部接口。\\n' +
          '已生成的 Key 仍有效，但不再校验。\\n\\n' +
          '确定要关闭吗？');
        if (!ok) { input.checked = true; return; }
      }
      setAuth(enable);
    }

    async function setAuth(enable) {
      var body = { enabled: enable };
      if (!enable) body.confirm = 'disable-auth';
      var r = await api('/api-keys/auth', { method: 'PUT', body: body });
      if (isAuthFail(r)) return;
      if (r.status !== 200 || !r.body || !r.body.ok) {
        toast('操作失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)) + '（鉴权状态未改变）');
        boot();
        return;
      }
      toast((r.body.data && r.body.data.message) || '已保存');
      boot();
    }

    function renderKeys() {
      var tbody = document.getElementById('keyTbody');
      var table = document.getElementById('keyTable');
      var empty = document.getElementById('keyEmpty');
      document.getElementById('keyLoading').style.display = 'none';

      if (!KEY_CACHE.length) {
        table.style.display = 'none';
        empty.style.display = '';
        return;
      }
      table.style.display = '';
      empty.style.display = 'none';

      tbody.innerHTML = KEY_CACHE.map(function (k) {
        var revoked = k.status !== 'active';
        var now = Date.now();
        var expired = !!k.expiresAt && k.expiresAt <= now;
        var badge;
        if (revoked) badge = '<span class="badge badge-revoked">已吊销</span>';
        else if (expired) badge = '<span class="badge badge-revoked">已过期</span>';
        else if (k.managed === false) badge = '<span class="badge badge-config">来自配置</span>';
        else badge = '<span class="badge badge-active">有效</span>';
        if (k.custom) badge += ' <span class="badge badge-config">自定义</span>';

        var actions = [];
        if (k.managed !== false && !revoked) {
          actions.push('<button class="btn btn-ghost btn-sm" data-act="copy" title="复制完整 Key">复制</button>');
          actions.push('<button class="btn btn-ghost btn-sm" data-act="rename">重命名</button>');
          actions.push('<button class="btn btn-ghost btn-sm" data-act="rotate">轮换</button>');
          actions.push('<button class="btn btn-danger btn-sm" data-act="revoke">吊销</button>');
        } else if (k.managed === false && !revoked) {
          actions.push('<span class="muted">配置文件 Key（在 config.json 管理）</span>');
          actions.push('<button class="btn btn-ghost btn-sm" data-act="copy" title="复制完整 Key">复制</button>');
        } else if (revoked) {
          actions.push('<span class="muted">已于 ' + fmtTime(k.revokedAt) + ' 吊销</span>');
          actions.push('<button class="btn btn-ghost btn-sm" data-act="del">删除</button>');
        }

        return '<tr class="' + (revoked ? 'row-revoked' : '') + '" data-id="' + esc(k.id) + '">' +
          '<td data-label="名称"><div>' + esc(k.name || '(未命名)') + '</div>' +
            (k.note ? '<div class="muted">' + esc(k.note) + '</div>' : '') + '</td>' +
          '<td data-label="密钥"><span class="key-masked">' + esc(k.keyPrefix || '••••••') + '</span></td>' +
          '<td data-label="创建时间" class="muted">' + fmtTime(k.createdAt) + '</td>' +
          '<td data-label="最近使用" class="muted">' + (k.lastUsedAt ? fmtTime(k.lastUsedAt) : '从未') + '</td>' +
          '<td data-label="状态">' + badge + '</td>' +
          '<td data-label="操作" class="cell-actions">' + actions.join(' ') + '</td>' +
          '</tr>';
      }).join('');
    }

    document.getElementById('keyTbody').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-act]');
      if (!btn) return;
      var row = btn.closest('tr[data-id]');
      if (!row) return;
      var id = row.getAttribute('data-id');
      var act = btn.getAttribute('data-act');
      if (act === 'rename') openRename(id);
      else if (act === 'rotate') openRotate(id);
      else if (act === 'revoke') openRevoke(id);
      else if (act === 'del') openDelete(id);
      else if (act === 'copy') copyExisting(btn, id);
    });

    async function writeClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        try { await navigator.clipboard.writeText(text); return; } catch (e) { /* 回退 */ }
      }
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      document.body.removeChild(ta);
      if (!ok) throw new Error('浏览器拒绝了剪贴板写入');
    }

    async function copyExisting(btn, id) {
      if (!requireAuth()) return;
      var label = btn.textContent;
      btn.disabled = true;
      btn.textContent = '读取中…';
      var plaintext = '';
      try {
        var r = await api('/api-keys/' + encodeURIComponent(id) + '/reveal', { method: 'POST' });
        if (isAuthFail(r)) return;
        if (r.status !== 200 || !r.body || !r.body.ok) {
          toast((r.body && r.body.error) || ('复制失败：HTTP ' + r.status));
          return;
        }
        plaintext = r.body.data.plaintext;
        await writeClipboard(plaintext);
        var rec = KEY_CACHE.find(function (x) { return x.id === id; });
        toast('已复制到剪贴板' + (rec && rec.name ? '：' + rec.name : ''));
      } catch (e) {
        toast('复制失败：' + ((e && e.message) || '未知错误'));
      } finally {
        plaintext = '';
        btn.disabled = false;
        btn.textContent = label;
      }
    }

    function onKeyModeChange() {
      var custom = document.getElementById('fKeyMode').value === 'custom';
      document.getElementById('fCustomWrap').style.display = custom ? '' : 'none';
      document.getElementById('fKeyModeHint').textContent = custom
        ? '使用你粘贴的值作为 Key，强度由你负责。'
        : '由本服务生成随机值，强度有保证。';
      document.getElementById('btnCreateSubmit').textContent = custom ? '保存' : '生成';
      if (custom) setTimeout(function () { document.getElementById('fCustomKey').focus(); }, 30);
    }

    function openCreate() {
      if (!requireAuth()) return;
      document.getElementById('fName').value = '';
      document.getElementById('fNote').value = '';
      document.getElementById('fExpire').value = '';
      document.getElementById('fKeyMode').value = 'random';
      document.getElementById('fCustomKey').value = '';
      document.getElementById('fNameError').style.display = 'none';
      document.getElementById('fName').classList.remove('input-invalid');
      document.getElementById('fCustomKeyError').style.display = 'none';
      document.getElementById('fCustomKey').classList.remove('input-invalid');
      onKeyModeChange();
      document.getElementById('dlgCreate').showModal();
      setTimeout(function () { document.getElementById('fName').focus(); }, 30);
    }

    async function submitCreate() {
      var nameEl = document.getElementById('fName');
      var name = nameEl.value.trim();
      var errEl = document.getElementById('fNameError');
      if (!name) {
        errEl.textContent = '名称不能为空';
        errEl.style.display = '';
        nameEl.classList.add('input-invalid');
        nameEl.focus();
        return;
      }
      var custom = document.getElementById('fKeyMode').value === 'custom';
      var customKeyEl = document.getElementById('fCustomKey');
      var customErrEl = document.getElementById('fCustomKeyError');
      var plaintext = custom ? customKeyEl.value : '';
      if (custom) {
        var msg = '';
        if (!plaintext) msg = '请粘贴要设置的 Key 值';
        else if (plaintext.length < 16 || plaintext.length > 256) msg = 'Key 长度需在 16-256 个字符之间';
        else if (!/^[\\x21-\\x7e]+$/.test(plaintext)) msg = 'Key 只能包含可见 ASCII 字符（不能含空格或换行）';
        if (msg) {
          customErrEl.textContent = msg;
          customErrEl.style.display = '';
          customKeyEl.classList.add('input-invalid');
          customKeyEl.focus();
          return;
        }
        customErrEl.style.display = 'none';
        customKeyEl.classList.remove('input-invalid');
      }
      var days = document.getElementById('fExpire').value;
      var btn = document.getElementById('btnCreateSubmit');
      var busyText = btn.textContent;
      btn.disabled = true;
      btn.textContent = custom ? '保存中…' : '生成中…';
      try {
        var r = await api('/api-keys', {
          method: 'POST',
          body: {
            name: name,
            note: document.getElementById('fNote').value.trim(),
            expiresInDays: days ? Number(days) : undefined,
            plaintext: custom ? plaintext : undefined,
          },
        });
        if (isAuthFail(r)) { closeDialog('dlgCreate'); return; }
        if (r.status !== 201 || !r.body || !r.body.ok) {
          toast((custom ? '保存失败' : '生成失败') + '，本次没有产生 Key：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          return;
        }
        closeDialog('dlgCreate');
        showReveal(r.body.data.plaintext, r.body.data.warning);
        await boot();
        highlightRow(r.body.data.key.id);
      } finally {
        btn.disabled = false;
        btn.textContent = busyText;
      }
    }

    function highlightRow(id) {
      setTimeout(function () {
        var row = document.querySelector('tr[data-id="' + id + '"]');
        if (row) row.classList.add('row-highlight');
      }, 60);
    }

    function showReveal(plaintext, hint) {
      if (hint) document.getElementById('revealHint').innerHTML = '<strong>完整 Key</strong>' + esc(hint);
      document.getElementById('revealBox').textContent = plaintext;
      document.getElementById('btnCopyKey').textContent = '复制 Key';
      document.getElementById('dlgReveal').showModal();
      setTimeout(function () { document.getElementById('btnCopyKey').focus(); }, 30);
    }

    async function copyReveal() {
      var text = document.getElementById('revealBox').textContent;
      try {
        await writeClipboard(text);
        document.getElementById('btnCopyKey').textContent = '✓ 已复制到剪贴板';
      } catch (e) {
        var range = document.createRange();
        range.selectNodeContents(document.getElementById('revealBox'));
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        toast('复制失败，已为你选中，请手动复制');
      }
    }

    function closeReveal() {
      document.getElementById('revealBox').textContent = '';
      closeDialog('dlgReveal');
    }

    (function guardReveal() {
      var dlg = document.getElementById('dlgReveal');
      dlg.addEventListener('cancel', function (e) {
        e.preventDefault();
        if (window.confirm('完整 Key 尚未确认保存，关闭后无法再次查看，确定关闭？')) closeReveal();
      });
      document.addEventListener('visibilitychange', function () {
        if (document.hidden && dlg.open) {
          document.getElementById('revealBox').textContent = '[已隐藏 — 完整 Key 无法再次显示；若尚未保存，请关闭后重新生成一条]';
        }
      });
    })();

    function openRename(id) {
      if (!requireAuth()) return;
      var k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('fRename').value = k.name || '';
      document.getElementById('fRenameNote').value = k.note || '';
      document.getElementById('dlgRename').showModal();
    }

    async function submitRename() {
      var r = await api('/api-keys/' + encodeURIComponent(currentTargetId), {
        method: 'PATCH',
        body: {
          name: document.getElementById('fRename').value.trim(),
          note: document.getElementById('fRenameNote').value.trim(),
        },
      });
      if (isAuthFail(r)) { closeDialog('dlgRename'); return; }
      if (r.status !== 200 || !r.body || !r.body.ok) {
        toast('保存失败：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        return;
      }
      closeDialog('dlgRename');
      toast('已保存');
      boot();
    }

    function openRotate(id) {
      if (!requireAuth()) return;
      var k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('rotateTargetName').textContent = k.name || '(未命名)';
      document.getElementById('fRotateName').value = '';
      document.getElementById('btnRotateSubmit').disabled = true;
      document.getElementById('dlgRotate').showModal();
      var input = document.getElementById('fRotateName');
      input.oninput = function () {
        document.getElementById('btnRotateSubmit').disabled = input.value.trim() !== (k.name || '');
      };
      setTimeout(function () { input.focus(); }, 30);
    }

    async function submitRotate() {
      var btn = document.getElementById('btnRotateSubmit');
      btn.disabled = true;
      try {
        var r = await api('/api-keys/' + encodeURIComponent(currentTargetId) + '/rotate', { method: 'POST' });
        if (isAuthFail(r)) { closeDialog('dlgRotate'); return; }
        if (r.status !== 200 || !r.body || !r.body.ok) {
          toast('轮换失败，旧 Key 仍然有效：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          return;
        }
        closeDialog('dlgRotate');
        showReveal(r.body.data.plaintext, r.body.data.warning);
        await boot();
        highlightRow(r.body.data.key.id);
      } finally {
        btn.disabled = false;
      }
    }

    function openRevoke(id) {
      if (!requireAuth()) return;
      var k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('revokeTargetName').textContent = k.name || '(未命名)';
      var input = document.getElementById('fRevokeName');
      input.value = '';
      document.getElementById('btnRevokeSubmit').disabled = true;
      document.getElementById('dlgRevoke').showModal();
      input.oninput = function () {
        document.getElementById('btnRevokeSubmit').disabled = input.value.trim() !== (k.name || '');
      };
      setTimeout(function () { input.focus(); }, 30);
    }

    async function submitRevoke() {
      var r = await api('/api-keys/' + encodeURIComponent(currentTargetId) + '/revoke', { method: 'POST' });
      if (isAuthFail(r)) { closeDialog('dlgRevoke'); return; }
      if (r.status !== 200 || !r.body || !r.body.ok) {
        toast('吊销失败，该 Key 仍然有效：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
        return;
      }
      closeDialog('dlgRevoke');
      toast((r.body.data && r.body.data.message) || '已吊销');
      boot();
    }

    function openDelete(id) {
      if (!requireAuth()) return;
      var k = KEY_CACHE.find(function (x) { return x.id === id; });
      if (!k) return;
      currentTargetId = id;
      document.getElementById('deleteTargetName').textContent = k.name || '(未命名)';
      document.getElementById('deleteTargetMasked').textContent = k.keyPrefix || '';
      document.getElementById('dlgDelete').showModal();
      setTimeout(function () { document.getElementById('btnDeleteSubmit').focus(); }, 30);
    }

    async function submitDelete() {
      var btn = document.getElementById('btnDeleteSubmit');
      btn.disabled = true;
      try {
        var r = await api('/api-keys/' + encodeURIComponent(currentTargetId), { method: 'DELETE' });
        if (isAuthFail(r)) { closeDialog('dlgDelete'); return; }
        if (r.status !== 200 || !r.body || !r.body.ok) {
          toast('删除失败，记录仍保留：' + ((r.body && r.body.error) || ('HTTP ' + r.status)));
          return;
        }
        closeDialog('dlgDelete');
        toast((r.body.data && r.body.data.message) || '已删除');
        boot();
      } finally {
        btn.disabled = false;
      }
    }

    async function checkUpdate(btn) {
      var box = document.getElementById('updateResult');
      if (btn) btn.disabled = true;
      box.textContent = '正在检查更新…';
      document.getElementById('dlgUpdate').showModal();
      try {
        var r = await fetch(BASE + '/system/updates', { cache: 'no-store' });
        var j = await r.json();
        var d = (j && j.data) || {};
        if (!j || j.ok !== true) throw new Error((j && j.error) || ('HTTP ' + r.status));
        var lines = ['当前版本：v' + (d.current || '?')];
        if (d.latest) lines.push('最新版本：v' + d.latest);
        if (d.updateAvailable === true) lines.push('✅ 有新版本可用。');
        else lines.push(d.note ? 'ℹ️ ' + d.note : '✅ 已是最新版本。');
        box.textContent = lines.join('\\n');
      } catch (err) {
        box.textContent = '⚠️ 检查失败：' + (err.message || err);
      } finally {
        if (btn) btn.disabled = false;
      }
    }

    function renderCurl() {
      document.getElementById('curlBox').textContent =
        'curl -H "Authorization: Bearer <key>" ' + BASE + '/system/status\\n\\n' +
        '# 或者使用 X-API-Key 头：\\n' +
        'curl -H "X-API-Key: <key>" ' + BASE + '/system/status';
    }
    function copyCurl() {
      writeClipboard(document.getElementById('curlBox').textContent)
        .then(function () { toast('已复制 curl 示例'); })
        .catch(function () { toast('复制失败，请手动选中复制'); });
    }

    boot();
  </script>
</body>
</html>`
}
