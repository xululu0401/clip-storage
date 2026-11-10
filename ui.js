/* 视频存储对账台 · ui.js
 * 只做三件事：把输入读成 cfg、把 cfg 交给 AppCore 算、把结果画到页面上。
 * 页面不通网、不上传任何数据；「保存到本机」写的是 localStorage。
 */
(function () {
  'use strict';
  var C = window.AppCore;
  var LS_KEY = 'clip-storage:v1';
  var COLORS = ['#0f5fa6', '#0f7b52', '#9a5b00', '#b42318', '#6b4fa8', '#0d7f8f', '#a8560f', '#5a6b7d'];
  var state = { cfg: C.defaultsClone(), res: null, errs: [], warns: [], patched: null, chartNarrow: null };

  /* 验收脚本用：证明「真实点击」确实落到了导出处理函数上 */
  window.__exports = 0;
  window.__ui = {
    state: state,
    refresh: function () { refresh(); },
    rebuild: function () { renderInputs(); refresh(); },
    applyPatch: function (p) { applyPatch(p); },
    setCfg: function (c) { state.cfg = C.normCfg(c); renderInputs(); refresh(); }
  };

  function $(id) { return document.getElementById(id); }
  function mk(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = String(text);
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.style.opacity = '0'; }, 2200);
  }
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }
  function downloadBlob(name, blob) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 0);
  }
  function stamp() {
    var d = new Date(), p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function baseName() { return '视频存储对账台-' + stamp(); }

  /* ── 读输入 ───────────────────────────── */
  var SCALAR_FIELDS = ['audioKbps', 'audioTracks', 'overheadPct', 'targetMinutes', 'capacity', 'usablePct',
    'gradeMBps', 'uploadMbps', 'uploadUtilPct', 'targetUploadMinutes', 'shootRatio', 'cameras', 'proxyMbps', 'bppRef'];

  function readInputs() {
    var cfg = state.cfg;
    cfg.label = $('g-label').value;
    cfg.capacityUnit = $('g-capacityUnit').value;
    SCALAR_FIELDS.forEach(function (f) {
      var el = $('g-' + f);
      if (el) cfg[f] = el.value;
    });
    var items = $('clips').querySelectorAll('.item');
    cfg.clips = [];
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var q = function (k) { return it.querySelector('[data-k="' + k + '"]'); };
      cfg.clips.push({
        name: q('name') ? q('name').value : '',
        w: q('w') ? q('w').value : '',
        h: q('h') ? q('h').value : '',
        fps: q('fps') ? q('fps').value : '',
        rateUnit: q('rateUnit') ? q('rateUnit').value : 'Mbps',
        rate: q('rate') ? q('rate').value : '',
        codec: q('codec') ? q('codec').value : 'H.265'
      });
    }
    if (cfg.pickedIdx >= cfg.clips.length) cfg.pickedIdx = cfg.clips.length - 1;
    if (cfg.pickedIdx < 0) cfg.pickedIdx = 0;
    return cfg;
  }

  /* ── 渲染输入区 ───────────────────────────── */
  /* 模板里的固定输入框是写死在 HTML 里的，这里统一补上 data-field，
     让文档级的事件委托能认出「这是一次真正的输入」。 */
  function tagStaticInputs() {
    SCALAR_FIELDS.forEach(function (f) {
      var el = $('g-' + f);
      if (el) {
        el.setAttribute('data-field', f);
        el.setAttribute('autocomplete', 'off');
      }
    });
    var lab = $('g-label');
    if (lab) lab.setAttribute('data-field', 'label');
    var unit = $('g-capacityUnit');
    if (unit) unit.setAttribute('data-field', 'capacityUnit');
  }

  function renderInputs() {
    var cfg = state.cfg;
    $('g-label').value = cfg.label;
    $('g-capacityUnit').value = cfg.capacityUnit;
    SCALAR_FIELDS.forEach(function (f) {
      var el = $('g-' + f);
      if (el) el.value = cfg[f] === undefined || cfg[f] === null ? '' : String(cfg[f]);
    });

    var box = $('clips');
    clear(box);
    cfg.clips.forEach(function (cl, i) {
      var it = mk('div', 'item' + (i === cfg.pickedIdx ? ' on' : ''));
      it.setAttribute('data-idx', String(i));
      var head = mk('div', 'itemhead');
      head.appendChild(mk('span', 'idx', '档位 ' + (i + 1)));
      var nm = document.createElement('input');
      nm.type = 'text';
      nm.value = cl.name;
      nm.setAttribute('data-k', 'name');
      nm.setAttribute('data-field', 'clips[' + i + '].name');
      nm.placeholder = '档位名（只用于显示）';
      head.appendChild(nm);
      var pick = mk('button', 'tiny' + (i === cfg.pickedIdx ? ' on' : ''), i === cfg.pickedIdx ? '当前档位' : '选中');
      pick.type = 'button';
      pick.setAttribute('data-act', 'pick');
      pick.setAttribute('data-idx', String(i));
      head.appendChild(pick);
      it.appendChild(head);

      var grid = mk('div', 'gridp');
      [['w', '宽（px）'], ['h', '高（px）'], ['fps', '帧率（fps）'], ['rate', '码率'], ['rateUnit', '码率单位'], ['codec', '编码']].forEach(function (spec) {
        var k = spec[0];
        var w2 = document.createElement('div');
        var lab = mk('label', null, spec[1]);
        w2.appendChild(lab);
        var inp;
        if (k === 'rateUnit') {
          inp = document.createElement('select');
          C.RATE_UNITS.forEach(function (u) { inp.appendChild(new Option(u, u, false, u === cl.rateUnit)); });
        } else if (k === 'codec') {
          inp = document.createElement('select');
          C.CODECS.forEach(function (u) { inp.appendChild(new Option(u, u, false, u === cl.codec)); });
        } else {
          inp = document.createElement('input');
          inp.type = 'text';
          inp.setAttribute('inputmode', 'decimal');
          inp.value = cl[k] === undefined || cl[k] === null ? '' : String(cl[k]);
        }
        inp.setAttribute('data-k', k);
        inp.setAttribute('data-field', 'clips[' + i + '].' + k);
        inp.setAttribute('autocomplete', 'off');
        w2.appendChild(inp);
        grid.appendChild(w2);
      });
      it.appendChild(grid);
      box.appendChild(it);
    });

    var sc = $('scenario');
    clear(sc);
    var opts = [{ id: '', name: '— 选一个内置场景 —', note: '' }].concat(C.scenarios());
    opts.forEach(function (s) { sc.appendChild(new Option(s.name, s.id, false, s.id === state.patched)); });
  }

  /* ── 渲染结果 ───────────────────────────── */
  function clearResults() {
    ['kpis', 'verdictDetail', 'insights', 'steps', 'revBox', 'clipBody', 'cardBody', 'sensBody', 'checks', 'legend'].forEach(function (id) {
      var n = $(id);
      if (n) clear(n);
    });
    $('verdictPill').textContent = '—';
    $('verdictPill').className = 'pill';
    $('checkTag').textContent = '—';
    $('chartTag').textContent = '—';
    $('baselineNote').textContent = '';
    $('mediaNote').textContent = '—';
    var wrap = $('chartWrap');
    clear(wrap);
    var d = document.createElement('div');
    d.id = 'chart';
    wrap.appendChild(d);
    state.res = null;
  }

  function refresh() {
    try {
      readInputs();
    } catch (e) {
      showErrors([{ field: '', msg: '读取输入失败：' + e.message }]);
      return;
    }
    var v = C.validate(state.cfg);
    state.warns = v.warnings || [];
    if (!v.ok) {
      clearResults();
      showErrors(v.errors);
      markBad(v.errors);
      return;
    }
    state.errs = [];
    markBad([]);
    var res;
    try { res = C.analyze(state.cfg); } catch (e) {
      showErrors([{ field: '', msg: '计算失败：' + e.message }]);
      return;
    }
    state.res = res;
    $('errBox').innerHTML = '';
    renderVerdict(res);
    renderChart(res);
    renderInsights(res);
    renderSteps(res);
    renderRev(res);
    renderClipTable(res);
    renderCardTable(res);
    renderSensTable(res);
    renderChecks(res);
  }

  function showErrors(errors) {
    var box = $('errBox');
    clear(box);
    var d = mk('div', 'errbox');
    d.appendChild(mk('b', null, '有 ' + errors.length + ' 处填错了，先把它们改过来：'));
    var ul = mk('ul');
    errors.slice(0, 12).forEach(function (e) { ul.appendChild(mk('li', null, e.msg)); });
    if (errors.length > 12) ul.appendChild(mk('li', null, '……还有 ' + (errors.length - 12) + ' 处'));
    d.appendChild(ul);
    box.appendChild(d);
  }

  function markBad(errors) {
    var nodes = document.querySelectorAll('[data-field]');
    for (var i = 0; i < nodes.length; i++) nodes[i].classList.remove('bad');
    var fields = {};
    errors.forEach(function (e) { if (e.field) fields[e.field] = 1; });
    Object.keys(fields).forEach(function (f) {
      var m = /^clips\[(\d+)\]\.(.+)$/.exec(f);
      var list = [];
      if (m) {
        var idx = m[1], key = m[2];
        if (key === 'wh') list = ['clips[' + idx + '].w', 'clips[' + idx + '].h'];
        else list = ['clips[' + idx + '].' + key];
      } else list = [f];
      list.forEach(function (fld) {
        var n = document.querySelector('[data-field="' + fld + '"]');
        if (n) n.classList.add('bad');
      });
    });
  }

  function renderVerdict(res) {
    var sel = res.sel;
    var pill = $('verdictPill');
    pill.className = 'pill ' + sel.verdict.id;
    pill.textContent = sel.verdict.label;
    var box = $('verdictDetail');
    clear(box);
    var rows = [
      ['当前档位', (sel.name || '第 ' + (res.selIdx + 1) + ' 档') + '：' + sel.w + '×' + sel.h + ' @ ' + C.fmtNum(sel.fps, 0) + ' fps · '
        + C.fmtNum(sel.rate, 2) + ' ' + sel.rateUnit + ' · ' + sel.codec],
      ['判定依据', sel.verdict.why + '；可录 ' + C.fmtDur(sel.recordMin) + ' ÷ 目标 ' + C.fmtDur(res.targetMinutes)
        + ' = ' + C.fmtNum(sel.ratio, 3) + ' 倍'],
      ['写入速度', (sel.writeOk === null ? '卡速未填（0），本次只判容量' : (sel.writeOk ? '够' : '不够') + '：平均写入需求 '
        + C.fmtMBps(sel.bps) + '，卡上标的 ' + C.fmtNum(res.cfg.gradeMBps, 1) + ' MB/s')],
      ['介质', '标称 ' + C.fmtNum(res.cfg.capacity, 2) + ' ' + res.cfg.capacityUnit + ' → 可用 '
        + C.fmtBytesBoth(res.media.usable) + '（可用比例 ' + C.fmtPct(res.cfg.usablePct, 0) + '）']
    ];
    rows.forEach(function (r) {
      box.appendChild(mk('div', 'k', r[0]));
      box.appendChild(mk('div', 'v', r[1]));
    });

    var kpi = function (lab, val, note) {
      var d = mk('div', 'kpi');
      d.appendChild(mk('div', 'lab', lab));
      d.appendChild(mk('div', 'val', val));
      if (note) d.appendChild(mk('div', 'note', note));
      return d;
    };
    var k = $('kpis');
    clear(k);
    k.appendChild(kpi('每秒占用', C.fmtMBps(sel.bps), '每分钟 ' + C.fmtNum(sel.mbPerMin, 1) + ' MB'));
    k.appendChild(kpi('目标 ' + C.fmtDur(res.targetMinutes) + ' 文件', C.fmtNum(sel.targetGB, 2) + ' GB', C.fmtGiB(sel.targetBytes) + '（系统显示）'));
    k.appendChild(kpi('能录多久', C.fmtDur(sel.recordMin), '余量 ' + C.fmtPct((sel.ratio - 1) * 100, 1)));
    k.appendChild(kpi('写入需求', C.fmtNum(sel.writeMBps, 2) + ' MB/s',
      sel.writeOk === null ? '卡速未填，只判容量' : (sel.gradeNeed ? '最低 ' + sel.gradeNeed + ' 级' : '超出 V90')));
    k.appendChild(kpi('bpp', C.fmtBpp(sel.bpp), '参考下限 ' + C.fmtBpp(res.cfg.bppRef)));
    k.appendChild(kpi('上传耗时', sel.uploadMin === null ? '—' : C.fmtDur(sel.uploadMin), sel.uploadMin === null ? '带宽或利用率为 0' : '期望 ' + C.fmtDur(res.cfg.targetUploadMinutes)));
    k.appendChild(kpi('项目总存储', C.fmtBytes(res.projectBytes), '成片 ' + C.fmtBytes(res.deliveryBytes) + ' 的 ' + C.fmtNum(res.projectBytes / res.deliveryBytes, 2) + ' 倍'));
    k.appendChild(kpi('需要卡张数', String(res.cardsNeeded) + ' 张', '单张可用 ' + C.fmtBytes(res.media.usable)));

    $('baselineNote').textContent = '口径：码率按恒定处理（真实素材是 VBR）；文件 = (视频 + 音频) × (1 + 封装开销) ÷ 8 × 时长；'
      + '容量按标称 × 进制系数 × 可用比例折算。「bpp」= 码率 ÷ (宽 × 高 × 帧率)，只用于档位之间横向比。';

    var note = $('mediaNote');
    note.textContent = '这台介质：标称 ' + C.fmtNum(res.cfg.capacity, 2) + ' ' + res.cfg.capacityUnit + ' = '
      + C.fmtBytes(res.media.total) + ' = ' + C.fmtGiB(res.media.total) + '；乘可用比例 ' + C.fmtPct(res.cfg.usablePct, 0)
      + ' 之后真正能写 ' + C.fmtBytesBoth(res.media.usable) + '。' + (res.cfg.gradeMBps > 0
        ? '保证持续写入 ' + C.fmtNum(res.cfg.gradeMBps, 1) + ' MB/s。' : '卡速填的是 0，本次不判写入速度。');

    if (state.warns.length) {
      var w = mk('div', 'warnbox');
      w.appendChild(mk('b', null, '提醒：'));
      var ul = mk('ul');
      state.warns.forEach(function (x) { ul.appendChild(mk('li', null, x)); });
      w.appendChild(ul);
      w.style.margin = '8px 0 10px';
      $('errBox').appendChild(w);
    }
  }

  /* ── 容量曲线 ───────────────────────────── */
  /* 粗略估算 SVG 文字宽度：中日韩字符按 1em，其余按 0.58em */
  function estWidth(text, fs) {
    var w = 0;
    for (var i = 0; i < String(text).length; i++) w += String(text).charCodeAt(i) > 0x2e80 ? fs : fs * 0.58;
    return w;
  }

  function niceTicks(max, n) {
    if (!(max > 0)) return [0, 1];
    var raw = max / n;
    var mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var norm = raw / mag;
    var step = mag * (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10);
    var out = [];
    for (var v = 0; v <= max + step * 0.5; v += step) out.push(Math.round(v * 1e6) / 1e6);
    return out;
  }

  function renderChart(res) {
    var wrap = $('chartWrap');
    var box = $('chart');
    var W = Math.max(300, Math.min(900, Math.round(wrap.clientWidth || 640) - 10));
    var narrow = W < 620;
    var H = narrow ? 340 : 400;
    var pad = narrow ? { l: 46, r: 12, t: 16, b: 40 } : { l: 62, r: 16, t: 18, b: 42 };
    var fs = narrow ? 11 : 12;

    var maxRecord = Math.max.apply(null, res.clips.map(function (k) { return k.recordMin; }));
    var xMax = Math.max(res.targetMinutes, Math.min(res.sel.recordMin, maxRecord)) * 1.06;
    if (!Number.isFinite(xMax) || xMax <= 0) xMax = res.targetMinutes;
    var gbPerMin = res.sel.bps * 60 / 1e9;
    var yMax = Math.max(res.media.usable / 1e9, gbPerMin * xMax) * 1.06;
    var x = function (min) { return pad.l + (min / xMax) * (W - pad.l - pad.r); };
    var y = function (gb) { return H - pad.b - (gb / yMax) * (H - pad.t - pad.b); };

    var svgNS = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    svg.setAttribute('width', String(W));
    svg.setAttribute('height', String(H));
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', '容量曲线：每个档位的占用速度与介质可用容量');
    var append = function (tag, attrs, text) {
      var e = document.createElementNS(svgNS, tag);
      Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (text !== undefined) e.textContent = text;
      svg.appendChild(e);
      return e;
    };
    // 裁剪区：直线超出画布时不画到坐标轴外面
    var defs = document.createElementNS(svgNS, 'defs');
    var cp = document.createElementNS(svgNS, 'clipPath');
    cp.setAttribute('id', 'plotClip');
    var cpr = document.createElementNS(svgNS, 'rect');
    cpr.setAttribute('x', String(pad.l)); cpr.setAttribute('y', String(pad.t));
    cpr.setAttribute('width', String(W - pad.l - pad.r)); cpr.setAttribute('height', String(H - pad.t - pad.b));
    cp.appendChild(cpr); defs.appendChild(cp); svg.appendChild(defs);

    var yUnit = yMax >= 1000 ? { d: 1000, n: 'TB' } : { d: 1, n: 'GB' };
    var showY = C.fmtNum(res.media.usable / 1e9 / yUnit.d, 1) + ' ' + yUnit.n;
    var yTicks = niceTicks(yMax / yUnit.d, narrow ? 4 : 5);
    yTicks.forEach(function (v) {
      var yy = y(v * yUnit.d);
      if (yy < pad.t - 1 || yy > H - pad.b + 1) return;
      append('line', { x1: pad.l, y1: yy, x2: W - pad.r, y2: yy, stroke: '#eef1f4', 'stroke-width': 1 });
      append('text', { x: pad.l - 6, y: yy + 4, 'text-anchor': 'end', 'font-size': fs, fill: '#7b8794' },
        C.fmtNum(v, v > 0 && v < 10 ? 1 : 0));
    });
    var useHours = xMax > 600;
    var xTicks = niceTicks(xMax, narrow ? 3 : 5);
    xTicks.forEach(function (v) {
      var xx = x(v);
      if (xx > W - pad.r - 8) return;
      append('text', { x: xx, y: H - pad.b + 16, 'text-anchor': 'middle', 'font-size': fs, fill: '#7b8794' },
        useHours ? C.fmtNum(v / 60, 1) + '时' : C.fmtNum(v, 0) + '分');
    });
    append('text', { x: pad.l - 6, y: pad.t + 2, 'text-anchor': 'end', 'font-size': fs, fill: '#7b8794' }, yUnit.n);
    append('text', { x: W - pad.r, y: H - 6, 'text-anchor': 'end', 'font-size': fs, fill: '#7b8794' }, '录制时长');
    append('line', { x1: pad.l, y1: H - pad.b, x2: W - pad.r, y2: H - pad.b, stroke: '#cbd2da', 'stroke-width': 1 });
    append('line', { x1: pad.l, y1: pad.t, x2: pad.l, y2: H - pad.b, stroke: '#cbd2da', 'stroke-width': 1 });

    // 目标时长竖线
    if (res.targetMinutes <= xMax) {
      append('line', {
        x1: x(res.targetMinutes), y1: pad.t, x2: x(res.targetMinutes), y2: H - pad.b,
        stroke: '#7b8794', 'stroke-width': 1.4, 'stroke-dasharray': '5 4'
      });
      var tText = '目标 ' + C.fmtDur(res.targetMinutes);
      var anchorLeft = x(res.targetMinutes) > pad.l + (W - pad.l - pad.r) * 0.6;
      append('text', {
        x: x(res.targetMinutes) + (anchorLeft ? -4 : 4),
        y: pad.t + fs + 2, 'text-anchor': anchorLeft ? 'end' : 'start', 'font-size': fs, fill: '#4a5568'
      }, tText);
    }

    var g = document.createElementNS(svgNS, 'g');
    g.setAttribute('clip-path', 'url(#plotClip)');
    svg.appendChild(g);   /* 放在最上层；裁剪区保证它不会盖住坐标轴外的文字 */
    var gadd = function (tag, attrs, text) {
      var e = document.createElementNS(svgNS, tag);
      Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
      if (text !== undefined) e.textContent = text;
      g.appendChild(e);
      return e;
    };
    // 各档位直线
    res.clips.forEach(function (k, i) {
      var slope = k.bps * 60 / 1e9;
      var isSel = i === res.selIdx;
      gadd('line', {
        x1: x(0), y1: y(0), x2: x(xMax), y2: y(slope * xMax),
        stroke: COLORS[i % COLORS.length], 'stroke-width': isSel ? 2.6 : 1.5,
        'stroke-opacity': isSel ? 1 : 0.55
      });
      if (k.recordMin <= xMax) {
        gadd('circle', {
          cx: x(k.recordMin), cy: y(res.media.usable / 1e9), r: isSel ? 4.4 : 3,
          fill: COLORS[i % COLORS.length], stroke: '#fff', 'stroke-width': 1.2
        });
      }
    });
    // 介质可用容量线
    gadd('line', {
      x1: x(0), y1: y(res.media.usable / 1e9), x2: x(xMax), y2: y(res.media.usable / 1e9),
      stroke: '#b42318', 'stroke-width': 2, 'stroke-dasharray': '7 4'
    });
    /* 介质可用容量标签：加一层白底，别被曲线与虚线穿过去 */
    var mLabel = '介质可用 ' + showY;
    var mw = estWidth(mLabel, fs) + 12;
    var mx = Math.max(pad.l + 2, W - pad.r - 4 - mw);
    var my = y(res.media.usable / 1e9) - fs - 9;
    if (my < pad.t + 2) my = y(res.media.usable / 1e9) + 4;
    gadd('rect', { x: mx, y: my, width: mw, height: fs + 9, fill: '#ffffff', 'fill-opacity': 0.93, rx: 3 });
    gadd('text', { x: mx + 6, y: my + fs + 1, 'font-size': fs, fill: '#b42318' }, mLabel);

    $('chartWrap').replaceChild(svg, box);
    svg.id = 'chart';
    var lg = $('legend');
    clear(lg);
    var add = function (color, text, dash) {
      var s = mk('span');
      var i = mk('i');
      i.style.background = color;
      if (dash) i.style.borderTop = '2px dashed ' + color, i.style.background = 'transparent', i.style.height = '0';
      s.appendChild(i);
      s.appendChild(document.createTextNode(text));
      lg.appendChild(s);
    };
    res.clips.forEach(function (k, i) {
      add(COLORS[i % COLORS.length], (k.name || '第 ' + (k.idx + 1) + ' 档') + (i === res.selIdx ? '（当前）' : ''));
    });
    add('#b42318', '介质可用容量', true);
    $('chartTag').textContent = 'x 轴 0–' + C.fmtNum(xMax, 0) + ' 分钟 · y 轴 0–' + C.fmtNum(yMax, 0) + ' GB';
    state.chartNarrow = narrow;
  }

  function renderInsights(res) {
    var box = $('insights');
    clear(box);
    C.insights(res).forEach(function (x) {
      var li = mk('li');
      li.appendChild(mk('b', null, x.title));
      li.appendChild(mk('span', null, x.text));
      box.appendChild(li);
    });
  }

  function renderSteps(res) {
    var box = $('steps');
    clear(box);
    var list = C.steps(res);
    if (!list.length) {
      box.appendChild(mk('li', null, '当前设置没有需要改的地方：容量、卡速、带宽与 bpp 都在你自己划的线以上。'));
      return;
    }
    list.forEach(function (s) {
      var li = mk('li');
      li.appendChild(mk('b', null, s.title));
      li.appendChild(mk('span', null, s.text));
      if (s.patch) {
        var b = mk('button', 'tiny primary', '一键采用');
        b.type = 'button';
        b.setAttribute('data-act', 'adopt');
        b.setAttribute('data-idx', String(list.indexOf(s)));
        b.__patch = s.patch;
        li.appendChild(b);
      }
      box.appendChild(li);
    });
  }

  function renderRev(res) {
    var box = $('revBox');
    clear(box);
    var c = res.cfg;
    $('revTag').textContent = res.rev.reqGradeV ? res.rev.reqGradeV : '超出 V90';
    var hint = mk('p', 'footnote scrollhint', '表格比屏幕宽：左右滑动可以看到全部列（要解决的问题 / 临界值 / 回代检验）。');
    hint.style.margin = '0 0 8px';
    box.appendChild(hint);
    var tbl = mk('div', 'tw');
    var t = mk('table');
    t.id = 'revTable';
    var thead = mk('thead');
    var tr = mk('tr');
    ['要解决的问题', '临界值', '回代检验'].forEach(function (h) { tr.appendChild(mk('th', null, h)); });
    thead.appendChild(tr);
    t.appendChild(thead);
    var tb = mk('tbody');
    var add = function (a, b, d) {
      var r = mk('tr');
      r.appendChild(mk('td', null, a));
      r.appendChild(mk('td', null, b));
      r.appendChild(mk('td', null, d));
      tb.appendChild(r);
    };
    add('录满 ' + C.fmtDur(res.targetMinutes) + ' 至少要多大介质',
      C.fmtNum(res.rev.reqCapacity, 2) + ' ' + c.capacityUnit,
      '回代可录 ' + C.fmtDur(res.rev.reqCapacityBytes / res.sel.bps / 60) + '（当前标称 ' + C.fmtNum(c.capacity, 2) + ' ' + c.capacityUnit + '）');
    add('写入达标要多少卡速',
      C.fmtNum(res.rev.reqGradeMBps, 2) + ' MB/s' + (res.rev.reqGradeV ? '（' + res.rev.reqGradeV + '）' : '（超出 V90）'),
      res.sel.writeOk === null ? '卡速未填，无法比较' : (res.sel.writeOk ? '当前卡速够' : '当前卡速不够'));
    var backUpRate = res.rev.reqUploadMbps * 1e6 / 8 * (c.uploadUtilPct / 100);
    var backUpMin = backUpRate > 0 ? res.sel.targetBytes / backUpRate / 60 : null;
    add('想在 ' + C.fmtDur(c.targetUploadMinutes) + ' 内传完要多大带宽',
      C.fmtMbps(res.rev.reqUploadMbps),
      res.sel.uploadMin === null ? '当前带宽或利用率为 0，上传不可计算' : '回代上传 ' + C.fmtDur(backUpMin));
    add('要达到 bpp 参考下限 ' + C.fmtBpp(c.bppRef),
      C.fmtMbps(res.rev.reqRateMbpsForBpp),
      '回代 bpp ' + C.fmtBpp(res.rev.reqRateMbpsForBpp * 1e6 / res.sel.pxRate) + '（当前 ' + C.fmtBpp(res.sel.bpp) + '）');
    t.appendChild(tb);
    tbl.appendChild(t);
    box.appendChild(tbl);
    var note = mk('p', 'footnote');
    note.textContent = '四条都是闭式解，并且每条都用「改回输入再算一遍」验证过（见下面的结构自检）。'
      + '反推的容量与带宽都按你填的可用比例、利用率折算，不含任何安全系数。';
    box.appendChild(note);
  }

  function renderClipTable(res) {
    var tb = $('clipBody');
    clear(tb);
    res.clips.forEach(function (k, i) {
      var tr = mk('tr', 'pick' + (i === res.selIdx ? ' sel' : ''));
      tr.setAttribute('data-act', 'pick');
      tr.setAttribute('data-idx', String(i));
      var tdName = mk('td');
      tdName.appendChild(document.createTextNode((k.name || '第 ' + (k.idx + 1) + ' 档') + (i === res.selIdx ? ' ●' : '')));
      tdName.appendChild(mk('br'));
      tdName.appendChild(mk('span', 'pill ' + k.verdict.id, k.verdict.label));
      tr.appendChild(tdName);
      tr.appendChild(mk('td', null, k.w + '×' + k.h));
      tr.appendChild(mk('td', null, C.fmtNum(k.fps, 0)));
      tr.appendChild(mk('td', null, C.fmtNum(k.rate, 2) + ' ' + k.rateUnit));
      tr.appendChild(mk('td', null, C.fmtNum(k.bps / 1e6, 3)));
      tr.appendChild(mk('td', null, C.fmtNum(k.targetGB, 2) + ' GB'));
      tr.appendChild(mk('td', null, C.fmtDur(k.recordMin)));
      tr.appendChild(mk('td', null, C.fmtNum(k.writeMBps, 2)));
      tr.appendChild(mk('td', null, C.fmtBpp(k.bpp)));
      tb.appendChild(tr);
    });
  }

  function renderCardTable(res) {
    var tb = $('cardBody');
    clear(tb);
    var c = res.cfg;
    var add = function (a, b, d, e) {
      var tr = mk('tr');
      tr.appendChild(mk('td', null, a));
      tr.appendChild(mk('td', null, b));
      tr.appendChild(mk('td', null, d));
      tr.appendChild(mk('td', null, e));
      tb.appendChild(tr);
    };
    add('成片（1 份）', C.fmtDur(res.targetMinutes), C.fmtBytes(res.deliveryBytes), '当前档位，' + (res.sel.name || '第 ' + (res.selIdx + 1) + ' 档'));
    add('素材', C.fmtDur(res.sourceMin), C.fmtBytes(res.sourceBytes),
      C.fmtNum(c.shootRatio, 0) + ' 倍素材 × ' + C.fmtNum(c.cameras, 0) + ' 机位');
    add('代理文件', res.proxyBytes > 0 ? C.fmtDur(res.sourceMin) : '—', C.fmtBytes(res.proxyBytes),
      c.proxyMbps > 0 ? C.fmtMbps(c.proxyMbps) + ' 按素材时长算' : '未开启');
    var sum = mk('tr', 'sum');
    sum.appendChild(mk('td', null, '合计'));
    sum.appendChild(mk('td', null, '—'));
    sum.appendChild(mk('td', null, C.fmtBytesBoth(res.projectBytes, 1)));
    sum.appendChild(mk('td', null, '≈ ' + res.cardsNeeded + ' 张当前介质的全部可用空间'));
    tb.appendChild(sum);
    add('上传成片', res.sel.uploadMin === null ? '—' : C.fmtDur(res.sel.uploadMin), C.fmtBytes(res.deliveryBytes),
      res.sel.uploadMin === null ? '带宽或利用率为 0' : C.fmtMbps(c.uploadMbps) + ' × ' + C.fmtPct(c.uploadUtilPct, 0) + ' 利用率');
    add('上传全部素材', res.upBytesPerSec > 0 ? C.fmtDur(res.projectBytes / res.upBytesPerSec / 60) : '—',
      C.fmtBytes(res.projectBytes), res.upBytesPerSec > 0 ? '同一带宽下的乐观估计' : '带宽或利用率为 0');
    add('备份一份', res.upBytesPerSec > 0 ? C.fmtDur(res.projectBytes / res.upBytesPerSec / 60) : '—',
      C.fmtBytes(res.projectBytes), '本地再存一份同样的量（不含校验与重传）');
  }

  function renderSensTable(res) {
    var tb = $('sensBody');
    clear(tb);
    C.sensitivity(res.cfg).forEach(function (r) {
      var tr = mk('tr');
      tr.appendChild(mk('td', null, r.name));
      tr.appendChild(mk('td', null, C.fmtNum(r.writeMBps, 3)));
      tr.appendChild(mk('td', null, C.fmtNum(r.targetGB, 2) + ' GB'));
      tr.appendChild(mk('td', null, C.fmtDur(r.recordMin)));
      tr.appendChild(mk('td', null, r.uploadMin === null ? '—' : C.fmtDur(r.uploadMin)));
      tr.appendChild(mk('td', null, r.cards === null ? '—' : String(r.cards)));
      var td = mk('td');
      td.appendChild(mk('span', 'pill ' + r.verdict.id, r.verdict.label));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
  }

  function renderChecks(res) {
    var box = $('checks');
    clear(box);
    $('checkTag').textContent = res.checkSummary.pass + ' / ' + res.checkSummary.total;
    res.checks.forEach(function (x) {
      var li = mk('li', x.pass ? '' : 'no');
      li.appendChild(mk('b', null, x.pass ? '[✓] ' : '[×] '));
      li.appendChild(document.createTextNode(x.name + (x.detail ? '（' + x.detail + '）' : '')));
      box.appendChild(li);
    });
  }

  /* ── 结果卡 PNG（1080×1350，自底向上排布，避免叠字） ───── */
  function tokens(text) {
    var out = [], re = /[0-9][0-9.,%\/]*|[A-Za-z][A-Za-z0-9.+\/]*|\s+|[\s\S]/g, m;
    while ((m = re.exec(text)) !== null) out.push(m[0]);
    return out;
  }
  function wrapText(ctx, text, maxWidth) {
    var lines = [], cur = '';
    tokens(String(text)).forEach(function (tk) {
      if (/^\s+$/.test(tk)) tk = ' ';
      var t = cur + tk;
      if (ctx.measureText(t).width > maxWidth && cur) { lines.push(cur); cur = tk === ' ' ? '' : tk; }
      else cur = t;
    });
    if (cur) lines.push(cur);
    return lines;
  }
  function firstSentence(text, max) {
    var s = String(text);
    var m = /^[\s\S]{0,400}?。/.exec(s);
    var out = m ? m[0] : s;
    if (out.length > max) out = out.slice(0, max - 1) + '…';
    return out;
  }

  function drawResultCard(res, done) {
    var W = 1080, H = 1350;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    var FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
    var font = function (px, bold) { ctx.font = (bold ? '700 ' : '400 ') + px + 'px ' + FONT; };
    var M = 64, CW = W - M * 2;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    var ellipsis = function (text, maxW) {
      var t = String(text);
      while (ctx.measureText(t).width > maxW && t.length > 4) t = t.slice(0, -2) + '…';
      return t;
    };
    var rrect = function (x, y, w, h, fill, stroke) {
      ctx.fillStyle = fill;
      ctx.fillRect(x, y, w, h);
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); }
    };

    /* ── 先把每块的高度量出来，再自上而下排；放不下的块不画。
          流水式 y 累加在内容变长时一定会叠字，所以这里先量后排。 ── */
    font(52, true);
    var titleLines = wrapText(ctx, res.cfg.label || '未命名拍摄', CW).slice(0, 2);
    font(25);
    var subLines = wrapText(ctx, '当前档位：' + (res.sel.name || '第 ' + (res.selIdx + 1) + ' 档') + ' · ' + res.sel.w + '×' + res.sel.h
      + ' @ ' + C.fmtNum(res.sel.fps, 0) + ' fps · ' + C.fmtNum(res.sel.rate, 2) + ' ' + res.sel.rateUnit
      + ' · 介质 ' + C.fmtNum(res.cfg.capacity, 0) + ' ' + res.cfg.capacityUnit, CW).slice(0, 2);
    var verdictWhy = '可录 ' + C.fmtDur(res.sel.recordMin) + ' ÷ 目标 ' + C.fmtDur(res.targetMinutes) + ' = '
      + C.fmtNum(res.sel.ratio, 3) + ' 倍 · ' + res.sel.verdict.why;
    font(25);
    var whyLines = wrapText(ctx, verdictWhy, CW - 48).slice(0, 2);
    var ins = C.insights(res).slice(0, 3).map(function (x) {
      font(26, true);
      var h = wrapText(ctx, x.title, CW - 40);
      font(24);
      var b = wrapText(ctx, firstSentence(x.text, 120), CW - 40);
      return { head: h, body: b, height: h.length * 31 + b.length * 29 + 26 };
    });

    var y = 84;
    font(28); ctx.fillStyle = '#4a5568';
    ctx.fillText('视频存储对账台', M, y);
    y += 46;
    font(52, true); ctx.fillStyle = '#161b22';
    titleLines.forEach(function (l, i) { ctx.fillText(l, M, y + i * 60); });
    y += titleLines.length * 60 + 4;
    font(25); ctx.fillStyle = '#4a5568';
    subLines.forEach(function (l, i) { ctx.fillText(l, M, y + i * 32); });
    y += subLines.length * 32 + 18;
    var topLimit = y;
    var bottomLimit = H - 74;

    /* 1) 判定条 */
    var bandH = 62 + whyLines.length * 32;
    var color = res.sel.verdict.id === 'ok' ? ['#e8f6ef', '#0f7b52']
      : res.sel.verdict.id === 'tight' ? ['#fff5e5', '#9a5b00'] : ['#fdeceb', '#b42318'];
    rrect(M, y, CW, bandH, color[0], null);
    font(46, true); ctx.fillStyle = color[1];
    ctx.fillText(res.sel.verdict.label, M + 24, y + 52);
    font(25); ctx.fillStyle = color[1];
    whyLines.forEach(function (l, i) { ctx.fillText(l, M + 24, y + 88 + i * 32); });
    y += bandH + 20;

    /* 2) 六个 KPI（两列三行） */
    var kpiList = [
      ['每秒占用', C.fmtMBps(res.sel.bps), '每分钟 ' + C.fmtNum(res.sel.mbPerMin, 1) + ' MB'],
      ['目标 ' + C.fmtDur(res.targetMinutes) + ' 文件', C.fmtNum(res.sel.targetGB, 2) + ' GB', C.fmtGiB(res.sel.targetBytes) + '（系统显示）'],
      ['能录多久', C.fmtDur(res.sel.recordMin), '余量 ' + C.fmtPct((res.sel.ratio - 1) * 100, 1)],
      ['写入需求', C.fmtNum(res.sel.writeMBps, 2) + ' MB/s', res.sel.writeOk === null ? '卡速未填，只判容量' : (res.sel.gradeNeed ? '最低 ' + res.sel.gradeNeed + ' 级' : '超出 V90')],
      ['bpp', C.fmtBpp(res.sel.bpp), '参考下限 ' + C.fmtBpp(res.cfg.bppRef)],
      ['需要卡张数', res.cardsNeeded + ' 张', '项目共 ' + C.fmtBytes(res.projectBytes)]
    ];
    var boxH = 96, gap = 14, bw = CW / 2 - gap / 2;
    kpiList.forEach(function (k, i) {
      var cx = M + (i % 2) * (bw + gap);
      var cy = y + Math.floor(i / 2) * (boxH + gap);
      rrect(cx, cy, bw, boxH, '#fafbfc', '#e3e6eb');
      font(23); ctx.fillStyle = '#7b8794';
      ctx.fillText(ellipsis(k[0], bw - 36), cx + 18, cy + 30);
      font(36, true); ctx.fillStyle = '#161b22';
      ctx.fillText(ellipsis(k[1], bw - 36), cx + 18, cy + 68);
      font(21); ctx.fillStyle = '#7b8794';
      ctx.fillText(ellipsis(k[2], bw - 36), cx + 18, cy + 90);
    });
    y += 3 * boxH + 2 * gap + 20;

    /* 3) 档位表（最多 4 行） */
    var rows = res.clips.slice(0, 4);
    var rowH = 38, tableH = (rows.length + 1) * rowH + 14;
    if (y + tableH <= bottomLimit) {
      rrect(M, y, CW, tableH, '#fafbfc', '#e3e6eb');
      var cols = [M + 16, M + 244, M + 386, M + 512, M + 632];
      var widths = [208, 126, 112, 108, 196];
      var rightEdge = M + CW - 16;
      font(22); ctx.fillStyle = '#7b8794';
      ['档位', '分辨率', '码率', '每秒 MB', '可录'].forEach(function (h, k) {
        ctx.fillText(h, cols[k], y + 28);
      });
      ctx.textAlign = 'right';
      ctx.fillText('判定', rightEdge, y + 28);
      ctx.textAlign = 'left';
      rows.forEach(function (k, r) {
        var yy = y + 28 + (r + 1) * rowH;
        font(24, r === res.selIdx);
        ctx.fillStyle = r === res.selIdx ? '#0f5fa6' : '#161b22';
        ctx.fillText(ellipsis(k.name || '第 ' + (k.idx + 1) + ' 档', widths[0]), cols[0], yy);
        ctx.fillText(ellipsis(k.w + '×' + k.h, widths[1]), cols[1], yy);
        ctx.fillText(ellipsis(C.fmtNum(k.rate, 0) + ' ' + k.rateUnit, widths[2]), cols[2], yy);
        ctx.fillText(ellipsis(C.fmtNum(k.bps / 1e6, 2), widths[3]), cols[3], yy);
        ctx.fillText(ellipsis(C.fmtDur(k.recordMin), widths[4]), cols[4], yy);
        ctx.textAlign = 'right';
        ctx.fillText(k.verdict.label, rightEdge, yy);
        ctx.textAlign = 'left';
      });
      y += tableH + 20;
    }

    /* 4) 要点：能放几条放几条（放不下就不画，绝不压到页脚上） */
    ins.forEach(function (item) {
      if (y + item.height > bottomLimit) return;
      rrect(M, y, CW, item.height, '#f7fbff', '#d3e3f5');
      font(26, true); ctx.fillStyle = '#161b22';
      item.head.forEach(function (l, i) { ctx.fillText(l, M + 20, y + 32 + i * 31); });
      font(24); ctx.fillStyle = '#4a5568';
      item.body.forEach(function (l, i) { ctx.fillText(l, M + 20, y + 32 + item.head.length * 31 + i * 29); });
      y += item.height + 14;
    });

    /* 页脚（固定在最底部） */
    ctx.strokeStyle = '#e3e6eb'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(M, H - 62); ctx.lineTo(W - M, H - 62); ctx.stroke();
    font(21); ctx.fillStyle = '#7b8794';
    ctx.fillText('生成 ' + new Date().toLocaleString('zh-CN') + '（时长 ' + C.fmtDur(res.targetMinutes) + ' 等数字都可在页面上复算）', M, H - 32);

    if (cv.toBlob) cv.toBlob(function (b) { done(b); }, 'image/png');
    else done(null);
  }

  /* ── 交互 ───────────────────────────── */
  function applyPatch(p) {
    if (!p) return;
    if (p.scope === 'clip') {
      var i = p.idx;
      if (!state.cfg.clips[i]) return;
      Object.keys(p.values).forEach(function (k) { state.cfg.clips[i][k] = p.values[k]; });
    } else {
      Object.keys(p.values).forEach(function (k) { state.cfg[k] = p.values[k]; });
    }
    renderInputs();
    refresh();
  }

  function onEdit(e) {
    var t = e.target;
    if (!t || !t.getAttribute) return;
    if (t.getAttribute('data-field') === null) return;
    refresh();
  }

  function bind() {
    /* 输入区会被整体重建（换场景 / 读取 / 加档位 / 一键采用），所以用事件委托：
       直接 querySelectorAll 绑一遍的话，重建之后新输入框就没有监听了。 */
    document.addEventListener('input', onEdit);
    document.addEventListener('change', onEdit);

    $('clips').addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== this && !t.getAttribute('data-act')) t = t.parentNode;
      if (!t || t === this) return;
      var idx = Number(t.getAttribute('data-idx'));
      if (Number.isFinite(idx)) { state.cfg.pickedIdx = idx; renderInputs(); refresh(); }
    });

    $('btnAddClip').addEventListener('click', function () {
      if (state.cfg.clips.length >= C.CLIP_MAX) { toast('最多 ' + C.CLIP_MAX + ' 个档位'); return; }
      readInputs();
      var last = state.cfg.clips[state.cfg.clips.length - 1] || { w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 12, codec: 'H.264' };
      state.cfg.clips.push({
        name: '新档位 ' + (state.cfg.clips.length + 1), w: last.w, h: last.h, fps: last.fps,
        rateUnit: last.rateUnit, rate: last.rate, codec: last.codec
      });
      renderInputs();
      refresh();
    });
    $('btnDelClip').addEventListener('click', function () {
      readInputs();
      if (state.cfg.clips.length <= C.CLIP_MIN) { toast('至少保留 ' + C.CLIP_MIN + ' 个档位'); return; }
      state.cfg.clips.pop();
      if (state.cfg.pickedIdx >= state.cfg.clips.length) state.cfg.pickedIdx = state.cfg.clips.length - 1;
      renderInputs();
      refresh();
    });

    $('scenario').addEventListener('change', function () {
      var id = this.value;
      if (!id) return;
      state.cfg = C.scenarioCfg(id);
      state.patched = id;
      renderInputs();
      refresh();
      toast('已套用内置场景（虚构示例）');
    });
    $('btnReset').addEventListener('click', function () {
      state.cfg = C.defaultsClone();
      state.patched = null;
      renderInputs();
      refresh();
      toast('已恢复默认');
    });
    $('btnSave').addEventListener('click', function () {
      try {
        localStorage.setItem(LS_KEY, C.backupJson(state.cfg));
        toast('已保存到本机（localStorage）');
      } catch (e) { toast('保存失败：' + e.message); }
    });
    $('btnLoad').addEventListener('click', function () {
      var raw = null;
      try { raw = localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
      if (!raw) { toast('本机没有保存过数据'); return; }
      var back = C.readBackup(raw);
      if (!back.ok) { toast('读取失败：' + back.error); return; }
      state.cfg = back.cfg;
      state.patched = null;
      renderInputs();
      refresh();
      toast('已从本机恢复');
    });
    $('importFile').addEventListener('change', function () {
      var f = this.files && this.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        var back = C.readBackup(String(fr.result));
        if (!back.ok) { toast('导入失败：' + back.error); return; }
        state.cfg = back.cfg;
        state.patched = null;
        renderInputs();
        refresh();
        toast('已导入备份');
      };
      fr.onerror = function () { toast('读文件失败'); };
      fr.readAsText(f);
      this.value = '';
    });

    $('steps').addEventListener('click', function (e) {
      var t = e.target;
      if (!t || t.getAttribute('data-act') !== 'adopt') return;
      applyPatch(t.__patch);
      toast('已采用这条建议，下面的数字都重算了');
    });

    $('clipBody').addEventListener('click', function (e) {
      var tr = e.target && e.target.closest ? e.target.closest('tr') : null;
      if (!tr) return;
      var idx = Number(tr.getAttribute('data-idx'));
      if (Number.isFinite(idx)) { state.cfg.pickedIdx = idx; renderInputs(); refresh(); }
    });

    $('btnCsv').addEventListener('click', function () {
      window.__exports++;
      download(baseName() + '.csv', '\ufeff' + C.toCsv(state.cfg), 'text/csv;charset=utf-8');
    });
    $('btnMd').addEventListener('click', function () {
      window.__exports++;
      download(baseName() + '.md', C.toMd(state.cfg), 'text/markdown;charset=utf-8');
    });
    $('btnJson').addEventListener('click', function () {
      window.__exports++;
      download(baseName() + '.json', C.backupJson(state.cfg), 'application/json;charset=utf-8');
    });
    $('btnPng').addEventListener('click', function () {
      if (!state.res) { toast('先把填错的地方改过来，再导出结果卡'); return; }
      window.__exports++;
      drawResultCard(state.res, function (blob) {
        if (!blob) { toast('这个浏览器不支持导出图片'); return; }
        downloadBlob(baseName() + '-结果卡.png', blob);
      });
    });
    $('btnPrint').addEventListener('click', function () { window.print(); });

    window.addEventListener('resize', function () {
      if (!state.res) return;
      var w = Math.max(300, Math.min(900, Math.round($('chartWrap').clientWidth || 640) - 10));
      if ((w < 620) !== state.chartNarrow) renderChart(state.res);
    });
  }

  function boot() {
    var raw = null;
    try { raw = localStorage.getItem(LS_KEY); } catch (e) { raw = null; }
    if (raw) {
      var back = C.readBackup(raw);
      if (back.ok) state.cfg = back.cfg;
      else state.cfg = C.defaultsClone();
    }
    tagStaticInputs();
    renderInputs();
    bind();               /* 关键：必须调用，否则所有监听与按钮都挂不上 */
    refresh();
    if (raw) toast('已恢复上次保存的数据');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
