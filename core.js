/* 视频存储对账台 · core.js
 * 录视频之前把这笔账算清楚：能录多久、文件多大、要买多大的卡、传上去要多久。
 *
 * ── 需求简报（详见 ../需求与调研.md） ─────────────────────────────
 * 输入范围与单位：
 *   label 本轮拍摄的名称（只用于显示）
 *   clips[]  1–8 个录制档位，每个填：
 *     name 档位名 | w,h 分辨率 px [16, 20000] 整数 | fps 帧率 (0, 1000]
 *     rateUnit 码率单位 'Mbps' | 'MB/s' | rate 码率 (0, 100000]
 *     codec 编码标签 'H.264'|'H.265'|'ProRes'|'其他'（只用于显示与备注）
 *   audioKbps 单音轨码率 kbps [0, 10000]；audioTracks 音轨数 [1, 16]
 *   overheadPct 封装/容器开销 % [0, 50]（音视频之外的额外占比）
 *   targetMinutes 目标录制时长 分钟 (0, 100000]
 *   capacity 介质标称容量 (0, 1e7] + capacityUnit 'GB'(10^9 B) | 'GiB'(2^30 B)
 *   usablePct 介质可用比例 % (0, 100]（格式化保留、系统占用、留余量）
 *   gradeMBps 介质保证的最低持续写入 MB/s [0, 1e6]（0 = 未填，只判容量不判卡速）
 *   uploadMbps 上行带宽 Mbps [0, 1e6]；uploadUtilPct 带宽利用率 % [0, 100]
 *   targetUploadMinutes 期望上传完成时间 分钟 (0, 1e6]
 *   shootRatio 素材倍率 [1, 100]（拍 N 分钟素材剪 1 分钟成片）；cameras 机位台数 [1, 16]
 *   proxyMbps 代理文件码率 Mbps [0, 1e5]（0 = 不做代理）
 *   bppRef 每像素每帧比特的参考下限 [0, 10]
 *   pickedIdx 当前选中的档位下标
 *
 * 模型假设（都是设计选择，不是标准）：
 *   A1 码率按「恒定」处理：真实 VBR 会波动，本页不算峰值、不算掉速曲线。
 *   A2 文件大小 = 总比特率 × 时长 ÷ 8，另乘一个用户可填的封装开销；不建模文件系统簇大小、
 *      不建模相机分段文件的头部开销、不建模音频与视频的 mux 交错开销差异。
 *   A3 介质容量按标称换算到「字节」：GB 用 10^9、GiB 用 2^30；再乘可用比例得到可用字节。
 *      相机/系统按 GiB 显示，所以标称 128 GB 的卡在系统里显示约 119.2 GiB —— 这是显示口径，不是虚标。
 *   A4 写入判定用「平均码率 ÷ 8」对比介质保证的最低持续写入速度：现场峰值更高，
 *      所以「刚好达标」不是安全结论（页面把这条写出来）。
 *   A5 上传时长 = 文件字节 ÷ (带宽 ÷ 8 × 利用率)；不考虑协议开销、重传、服务端限速、断点续传。
 *   A6 bpp（bits per pixel per frame）只是「码率 ÷ 像素率」这个比值，本页用它做**档位之间**的比较，
 *      不把它当画质评分；参考下限由用户填，默认值只是设计选择。
 *
 * 关键公式：
 *   视频比特率 vb = rate × 10^6（rateUnit=Mbps）或 rate × 8 × 10^6（rateUnit=MB/s）
 *   音频比特率 ab = audioKbps × tracks × 1000
 *   每秒字节 Bps = (vb + ab) × (1 + overheadPct/100) ÷ 8
 *   目标文件字节 = Bps × targetMinutes × 60
 *   介质字节 = capacity × (10^9 或 2^30)；可用字节 = 介质字节 × usablePct/100
 *   可录时长(分钟) = 可用字节 ÷ Bps ÷ 60
 *   写入需求 MB/s = Bps ÷ 10^6
 *   bpp = vb ÷ (w × h × fps)
 *   上传时长(分钟) = 目标文件字节 ÷ (uploadMbps×10^6÷8 × util/100) ÷ 60
 *   素材时长 = targetMinutes × shootRatio × cameras；素材字节 = Bps × 素材时长 × 60
 *   代理字节 = proxyMbps×10^6÷8 × 素材时长 × 60（proxyMbps>0）
 *   项目总字节 = 素材 + 代理 + 成片
 *   需要卡张数 = ceil(项目总字节 ÷ 可用字节)
 *   反推 ① 要录满目标时长所需介质容量 = 目标文件字节 ÷ (usablePct/100)（换回用户单位）
 *   反推 ② 达到目标上传时长所需带宽 = 目标文件字节 ÷ (targetUploadMinutes×60) × 8 ÷ 10^6 ÷ (util/100)
 *   反推 ③ 达到参考 bpp 所需码率 = bppRef × w × h × fps ÷ 10^6（Mbps）
 *   反推 ④ 写入达标所需卡速等级 = 写入需求 MB/s（映射到 V6/V10/V30/V60/V90）
 *
 * 输出定义：
 *   判定三档（够用有余量 / 刚够没余量 / 不够）+ 8 个 KPI + 档位账 + 容量曲线（每个档位一条线，
 *   与介质可用容量线的交点就是可录时长）+ 素材与上传账 + 反推 + 10 行敏感性 + 18 项结构自检。
 *
 * 默认场景：虚构的「婚礼跟拍 · 卡片机位」示例（4 个档位、128 GB 卡、上行 100 Mbps），
 *           所有数字都是示例，不是任何机型的真实规格。
 *
 * 边界：档位 1–8 个；分辨率必须是整数 px 且 ≥16；码率 > 0；容量 > 0；可用比例 (0,100]；
 *       上行带宽 0 或利用率 0 → 上传时长记 null（不可计算），不返回 Infinity；
 *       素材倍率 ≥1；目标时长 > 0。
 * 无法处理：不测真实码率与画质、不判断器材好坏、不给购买建议、不查真实卡价与机型规格、
 *           不建模热降频/实时掉速/文件系统开销/断电坏文件、不算云盘与网盘限速、不联网。
 */
(function () {
  'use strict';
  const root = typeof window !== 'undefined' ? window : null;

  const SLUG = 'clip-storage';
  const NAME = '视频存储对账台';
  const VERSION = '1.0.0';
  const CLIP_MIN = 1;
  const CLIP_MAX = 8;
  const CODECS = ['H.264', 'H.265', 'ProRes', '其他'];
  const RATE_UNITS = ['Mbps', 'MB/s'];
  const CAP_UNITS = ['GB', 'GiB'];
  const V_GRADES = [6, 10, 30, 60, 90];
  const GB_DEC = 1e9;
  const GIB_BIN = Math.pow(2, 30);
  const CHECK_TOTAL = 18;

  /* ── 数值解析与格式化 ───────────────────────────── */
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    if (v === null || v === undefined) return NaN;
    let s = String(v).trim();
    if (!s) return NaN;
    s = s.replace(/[，,\s\u00a0]/g, '').replace(/[−–—]/g, '-').replace(/％/g, '%')
      .replace(/[０-９．]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/[%％]$/, '').replace(/。$/, '');
    if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return NaN;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }
  const clampNum = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  function round(x, d) {
    if (!Number.isFinite(x)) return x;
    const m = Math.pow(10, d);
    return Math.round((x + (x >= 0 ? 1 : -1) * Number.EPSILON * Math.abs(x)) * m) / m;
  }
  function ceilTo(x, step) {
    if (!Number.isFinite(x) || !Number.isFinite(step) || step <= 0) return x;
    const n = Math.ceil(round(x / step, 9));
    return round(n * step, 9);
  }
  function fmtNum(x, d) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    const digits = d === undefined ? 2 : d;
    const neg = x < 0;
    const s = Math.abs(x).toFixed(digits);
    const parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + parts.join('.');
  }
  const fmtInt = (x) => (Number.isFinite(x) ? fmtNum(Math.round(x), 0) : '—');
  function fmtPct(x, d) {
    if (x === null || x === undefined || !Number.isFinite(x)) return '—';
    return fmtNum(x, d === undefined ? 2 : d) + '%';
  }
  /* 十进制字节（B/KB/MB/GB/TB） */
  function fmtBytes(bytes, d) {
    if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
    const digits = d === undefined ? 2 : d;
    const a = Math.abs(bytes);
    if (a < 1000) return fmtNum(bytes, 0) + ' B';
    if (a < 1e6) return fmtNum(bytes / 1e3, digits) + ' KB';
    if (a < 1e9) return fmtNum(bytes / 1e6, digits) + ' MB';
    if (a < 1e12) return fmtNum(bytes / GB_DEC, digits) + ' GB';
    return fmtNum(bytes / 1e12, digits) + ' TB';
  }
  const fmtGB = (bytes, d) => (Number.isFinite(bytes) ? fmtNum(bytes / GB_DEC, d === undefined ? 2 : d) + ' GB' : '—');
  const fmtGiB = (bytes, d) => (Number.isFinite(bytes) ? fmtNum(bytes / GIB_BIN, d === undefined ? 2 : d) + ' GiB' : '—');
  const fmtBytesBoth = (bytes, d) => (Number.isFinite(bytes)
    ? fmtBytes(bytes, d) + '（' + fmtGiB(bytes, d) + '）' : '—');
  const fmtMBps = (bps, d) => (Number.isFinite(bps) ? fmtNum(bps / 1e6, d === undefined ? 2 : d) + ' MB/s' : '—');
  const fmtMbps = (mbps, d) => (Number.isFinite(mbps) ? fmtNum(mbps, d === undefined ? 2 : d) + ' Mbps' : '—');
  const fmtBpp = (x) => (Number.isFinite(x) ? fmtNum(x, 3) : '—');
  function fmtDur(minutes) {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '—';
    const m = Math.abs(minutes);
    if (m < 1) return fmtNum(minutes * 60, 0) + ' 秒';
    if (m < 60) return fmtNum(minutes, 2) + ' 分钟';
    const h = Math.floor(minutes / 60);
    const rest = minutes - h * 60;
    const rd = Math.abs(rest - Math.round(rest)) < 0.05 ? 0 : (rest >= 10 ? 0 : 1);
    if (Math.round(rest) === 0) return fmtInt(h) + ' 小时整';
    return fmtInt(h) + ' 小时 ' + fmtNum(rest, rd) + ' 分';
  }
  const fmtDuration = (minutes) => fmtDur(minutes);

  /* ── 默认与场景 ───────────────────────────── */
  function defaults() {
    return {
      label: '婚礼跟拍 · 卡片机位',
      clips: [
        { name: '4K60 主档', w: 3840, h: 2160, fps: 60, rateUnit: 'Mbps', rate: 100, codec: 'H.265' },
        { name: '4K30 省卡', w: 3840, h: 2160, fps: 30, rateUnit: 'Mbps', rate: 60, codec: 'H.265' },
        { name: '1080p60 直播', w: 1920, h: 1080, fps: 60, rateUnit: 'Mbps', rate: 20, codec: 'H.264' },
        { name: '1080p30 备机', w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 12, codec: 'H.264' }
      ],
      audioKbps: 320,
      audioTracks: 2,
      overheadPct: 1,
      targetMinutes: 60,
      capacity: 128,
      capacityUnit: 'GB',
      usablePct: 92,
      gradeMBps: 30,
      uploadMbps: 100,
      uploadUtilPct: 80,
      targetUploadMinutes: 60,
      shootRatio: 3,
      cameras: 2,
      proxyMbps: 0,
      bppRef: 0.06,
      pickedIdx: 0
    };
  }
  function defaultsClone() { return JSON.parse(JSON.stringify(defaults())); }

  function patch(base, over) {
    const c = JSON.parse(JSON.stringify(base));
    Object.keys(over || {}).forEach((k) => {
      if (k === 'clips') c.clips = JSON.parse(JSON.stringify(over.clips));
      else if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) Object.assign(c[k], over[k]);
      else c[k] = over[k];
    });
    return c;
  }

  function scenarios() {
    const base = defaults();
    const mk = (id, name, note, over) => ({ id, name, note, cfg: patch(base, over) });
    return [
      mk('default', '婚礼跟拍 4K60（默认）', '128 GB 卡、上行 100 Mbps、目标 60 分钟', {}),
      mk('phone', '手机 1080p30 直播', '32 GB 卡、上行 30 Mbps、目标 120 分钟', {
        label: '手机直播 · 1080p30', targetMinutes: 120, capacity: 32, capacityUnit: 'GB',
        gradeMBps: 10, uploadMbps: 30, targetUploadMinutes: 60, shootRatio: 1, cameras: 1,
        clips: [{ name: '1080p30 手机', w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 10, codec: 'H.265' }]
      }),
      mk('slowmo', '4K120 慢动作', '256 GB V60 卡、码率 200 Mbps、目标 30 分钟', {
        label: '体育跟拍 · 4K120 慢动作', targetMinutes: 30, capacity: 256, gradeMBps: 60,
        clips: [{ name: '4K120 慢动作', w: 3840, h: 2160, fps: 120, rateUnit: 'Mbps', rate: 200, codec: 'H.265' }]
      }),
      mk('prores', 'ProRes 高码率', '880 Mbps、上行 50 Mbps、目标 20 分钟', {
        label: '广告片 · ProRes 422', targetMinutes: 20, uploadMbps: 50, targetUploadMinutes: 40,
        clips: [{ name: 'ProRes 422', w: 3840, h: 2160, fps: 25, rateUnit: 'Mbps', rate: 880, codec: 'ProRes' }]
      }),
      mk('multicam', '三机位课程录制', '3 机位、素材倍率 5、目标 45 分钟', {
        label: '课程录制 · 三机位', targetMinutes: 45, cameras: 3, shootRatio: 5, capacity: 512,
        clips: [{ name: '4K30 主讲', w: 3840, h: 2160, fps: 30, rateUnit: 'Mbps', rate: 80, codec: 'H.265' },
          { name: '1080p30 副机', w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 25, codec: 'H.264' }]
      }),
      mk('slowup', '上行只有 20 Mbps', '拍得下、传不上去', {
        label: '远程交付 · 上行受限', uploadMbps: 20, targetUploadMinutes: 90, proxyMbps: 20
      }),
      mk('marathon', '8 小时会议录制', '长时间、目标 480 分钟', {
        label: '会议录制 · 8 小时', targetMinutes: 480, capacity: 256, shootRatio: 1, cameras: 1,
        clips: [{ name: '1080p30 会议', w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 8, codec: 'H.264' }]
      }),
      mk('tiny', '32 GB 应急卡', '卡小、目标 240 分钟', {
        label: '外拍应急 · 32 GB', targetMinutes: 240, capacity: 32, shootRatio: 1, cameras: 1
      }),
      mk('nograde', '未标卡速的卡', '卡速 0 = 只判容量不判写入', {
        label: '只剩一张杂牌卡', gradeMBps: 0, capacityUnit: 'GiB', capacity: 119
      })
    ];
  }
  function scenarioCfg(id) {
    const s = scenarios().filter((x) => x.id === id)[0];
    return s ? JSON.parse(JSON.stringify(s.cfg)) : defaultsClone();
  }

  /* ── 归一化 ───────────────────────────── */
  function normClip(cl) {
    const o = cl && typeof cl === 'object' ? cl : {};
    return {
      name: o.name === undefined || o.name === null ? '' : String(o.name),
      w: num(o.w), h: num(o.h), fps: num(o.fps),
      rateUnit: RATE_UNITS.indexOf(o.rateUnit) >= 0 ? o.rateUnit : 'Mbps',
      rate: num(o.rate),
      codec: CODECS.indexOf(o.codec) >= 0 ? o.codec : (o.codec === undefined || o.codec === null || o.codec === '' ? 'H.265' : '其他')
    };
  }
  function normCfg(cfg) {
    const d = defaults();
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    const clipsIn = Array.isArray(c.clips) ? c.clips : d.clips;
    return {
      label: c.label === undefined || c.label === null ? d.label : String(c.label),
      clips: clipsIn.map(normClip),
      audioKbps: c.audioKbps === undefined ? d.audioKbps : num(c.audioKbps),
      audioTracks: c.audioTracks === undefined ? d.audioTracks : num(c.audioTracks),
      overheadPct: c.overheadPct === undefined ? d.overheadPct : num(c.overheadPct),
      targetMinutes: c.targetMinutes === undefined ? d.targetMinutes : num(c.targetMinutes),
      capacity: c.capacity === undefined ? d.capacity : num(c.capacity),
      capacityUnit: CAP_UNITS.indexOf(c.capacityUnit) >= 0 ? c.capacityUnit : d.capacityUnit,
      usablePct: c.usablePct === undefined ? d.usablePct : num(c.usablePct),
      gradeMBps: c.gradeMBps === undefined ? d.gradeMBps : num(c.gradeMBps),
      uploadMbps: c.uploadMbps === undefined ? d.uploadMbps : num(c.uploadMbps),
      uploadUtilPct: c.uploadUtilPct === undefined ? d.uploadUtilPct : num(c.uploadUtilPct),
      targetUploadMinutes: c.targetUploadMinutes === undefined ? d.targetUploadMinutes : num(c.targetUploadMinutes),
      shootRatio: c.shootRatio === undefined ? d.shootRatio : num(c.shootRatio),
      cameras: c.cameras === undefined ? d.cameras : num(c.cameras),
      proxyMbps: c.proxyMbps === undefined ? d.proxyMbps : num(c.proxyMbps),
      bppRef: c.bppRef === undefined ? d.bppRef : num(c.bppRef),
      pickedIdx: c.pickedIdx === undefined ? d.pickedIdx : Math.round(num(c.pickedIdx))
    };
  }

  /* ── 校验 ───────────────────────────── */
  function validate(cfg) {
    const c = normCfg(cfg);
    const errors = [];
    const warnings = [];
    const E = (field, msg) => errors.push({ field, msg });
    const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

    if (!c.clips.length) E('clips', '至少要有 1 个录制档位');
    if (c.clips.length > CLIP_MAX) E('clips', '最多 8 个录制档位，当前 ' + c.clips.length + ' 个');
    c.clips.forEach((cl, i) => {
      const tag = 'clips[' + i + ']';
      const nm = cl.name ? '「' + cl.name + '」' : '第 ' + (i + 1) + ' 档';
      if (!Number.isFinite(cl.w) || !Number.isFinite(cl.h) || cl.w < 16 || cl.h < 16 || cl.w > 20000 || cl.h > 20000) {
        E(tag + '.wh', nm + ' 的分辨率必须是 16–20000 之间的数字（宽 × 高）');
      } else if (Math.abs(cl.w - Math.round(cl.w)) > 1e-9 || Math.abs(cl.h - Math.round(cl.h)) > 1e-9) {
        E(tag + '.wh', nm + ' 的分辨率必须是整数像素');
      }
      if (!Number.isFinite(cl.fps) || cl.fps <= 0 || cl.fps > 1000) E(tag + '.fps', nm + ' 的帧率必须在 (0, 1000] 之间');
      if (!Number.isFinite(cl.rate) || cl.rate <= 0) E(tag + '.rate', nm + ' 的码率必须大于 0');
      else if (cl.rate > 100000) E(tag + '.rate', nm + ' 的码率超过 100000（' + cl.rateUnit + '），请检查单位是否选错');
    });
    if (!inRange(c.audioKbps, 0, 10000)) E('audioKbps', '单音轨码率必须在 0–10000 kbps 之间');
    if (!inRange(c.audioTracks, 1, 16)) E('audioTracks', '音轨数必须在 1–16 之间');
    else if (Math.abs(c.audioTracks - Math.round(c.audioTracks)) > 1e-9) E('audioTracks', '音轨数必须是整数');
    if (!inRange(c.overheadPct, 0, 50)) E('overheadPct', '封装开销必须在 0–50% 之间');
    if (!Number.isFinite(c.targetMinutes) || c.targetMinutes <= 0 || c.targetMinutes > 100000) {
      E('targetMinutes', '目标录制时长必须在 (0, 100000] 分钟之间');
    }
    if (!Number.isFinite(c.capacity) || c.capacity <= 0 || c.capacity > 1e7) E('capacity', '介质容量必须大于 0（单位 ' + c.capacityUnit + '）');
    if (!Number.isFinite(c.usablePct) || c.usablePct <= 0 || c.usablePct > 100) E('usablePct', '可用比例必须在 (0, 100] 之间');
    if (!inRange(c.gradeMBps, 0, 1e6)) E('gradeMBps', '保证持续写入速度必须在 0–1e6 MB/s 之间（0 = 未填）');
    if (!inRange(c.uploadMbps, 0, 1e6)) E('uploadMbps', '上行带宽必须在 0–1e6 Mbps 之间');
    if (!inRange(c.uploadUtilPct, 0, 100)) E('uploadUtilPct', '带宽利用率必须在 0–100% 之间');
    if (!Number.isFinite(c.targetUploadMinutes) || c.targetUploadMinutes <= 0 || c.targetUploadMinutes > 1e6) {
      E('targetUploadMinutes', '期望上传时间必须在 (0, 1000000] 分钟之间');
    }
    if (!inRange(c.shootRatio, 1, 100)) E('shootRatio', '素材倍率必须在 1–100 之间');
    if (!inRange(c.cameras, 1, 16)) E('cameras', '机位台数必须在 1–16 之间');
    else if (Math.abs(c.cameras - Math.round(c.cameras)) > 1e-9) E('cameras', '机位台数必须是整数（半台机位没有意义）');
    if (!inRange(c.proxyMbps, 0, 1e5)) E('proxyMbps', '代理文件码率必须在 0–100000 Mbps 之间（0 = 不做代理）');
    if (!inRange(c.bppRef, 0, 10)) E('bppRef', 'bpp 参考下限必须在 0–10 之间');

    if (!errors.length) {
      const sel = clampIdx(c.pickedIdx, c.clips.length);
      if (c.gradeMBps === 0) warnings.push('卡速填 0：本次只判「容量够不够」，不判「写入速度够不够」。');
      if (c.uploadMbps === 0 || c.uploadUtilPct === 0) warnings.push('上行带宽或利用率是 0：上传时长不可计算，会显示「—」而不是无穷大。');
      if (c.usablePct > 95) warnings.push('可用比例 ' + fmtPct(c.usablePct, 0) + ' 偏高：格式化与文件系统通常会占掉一部分，实际能用的字节往往更少。');
      const r = quickRate(c, sel);
      if (Number.isFinite(r.writeMBps) && c.gradeMBps > 0 && r.writeMBps > c.gradeMBps * 0.9 && r.writeMBps <= c.gradeMBps) {
        warnings.push('写入需求 ' + fmtMBps(r.bps) + ' 已经贴到卡速上限 ' + fmtNum(c.gradeMBps, 1) + ' MB/s：现场峰值更高时会掉帧，别把「刚好达标」当安全。');
      }
      if (c.clips.length === 1) warnings.push('只填了 1 个档位：档位之间没法对照，把备选档位也填上才能看出每像素比特的差别。');
    }
    return { ok: errors.length === 0, errors, warnings, cfg: c };
  }
  function clampIdx(i, n) {
    if (!Number.isFinite(i)) return 0;
    return Math.max(0, Math.min(n - 1, Math.round(i)));
  }

  /* ── 单档位换算（供校验、检查、敏感性复用） ───────────── */
  function clipBitsPerSec(clip) {
    const rate = num(clip.rate);
    return clip.rateUnit === 'MB/s' ? rate * 8e6 : rate * 1e6;
  }
  function quickRate(c, idx) {
    const cl = c.clips[clampIdx(idx, c.clips.length)] || c.clips[0];
    if (!cl) return { bps: NaN, wireMBps: NaN, bpp: NaN, videoBits: NaN, audioBits: NaN };
    const videoBits = clipBitsPerSec(cl);
    const audioBits = num(c.audioKbps) * num(c.audioTracks) * 1000;
    const bps = (videoBits + audioBits) * (1 + num(c.overheadPct) / 100) / 8;
    const px = num(cl.w) * num(cl.h) * num(cl.fps);
    return {
      videoBits, audioBits, bps, writeMBps: bps / 1e6,
      bpp: px > 0 && Number.isFinite(videoBits) ? videoBits / px : NaN
    };
  }

  function mediaBytes(c) {
    const cap = num(c.capacity);
    const unit = c.capacityUnit === 'GiB' ? GIB_BIN : GB_DEC;
    const total = cap * unit;
    return { total, usable: total * num(c.usablePct) / 100, unitBytes: unit };
  }

  function verdictOf(ratio, writeOk) {
    if (writeOk === false) return { id: 'bad', label: '不够', why: '卡速不足' };
    if (!Number.isFinite(ratio)) return { id: 'bad', label: '不够', why: '无法计算' };
    if (ratio >= 1.2) return { id: 'ok', label: '够用，有余量', why: '容量与写入速度都通过' };
    if (ratio >= 1) return { id: 'tight', label: '刚够，没余量', why: '容量刚好覆盖目标时长' };
    return { id: 'bad', label: '不够', why: ratio > 0 ? '容量不够' : '无法计算' };
  }

  function gradeLabel(need) {
    if (!Number.isFinite(need)) return null;
    for (let i = 0; i < V_GRADES.length; i++) if (need <= V_GRADES[i] + 1e-9) return 'V' + V_GRADES[i];
    return null;
  }

  /* ── 主计算 ───────────────────────────── */
  function analyze(cfg) {
    const c = normCfg(cfg);
    const v = validate(c);
    if (!v.ok) {
      const err = new Error('输入有 ' + v.errors.length + ' 处问题，未计算');
      err.validation = v;
      throw err;
    }
    const m = mediaBytes(c);
    const targetSec = num(c.targetMinutes) * 60;
    const overhead = 1 + num(c.overheadPct) / 100;
    const audioBits = num(c.audioKbps) * num(c.audioTracks) * 1000;
    const upBytesPerSec = num(c.uploadMbps) * 1e6 / 8 * (num(c.uploadUtilPct) / 100);
    const selIdx = clampIdx(c.pickedIdx, c.clips.length);

    const clips = c.clips.map((cl, i) => {
      const videoBits = clipBitsPerSec(cl);
      const totalBits = (videoBits + audioBits) * overhead;
      const bps = totalBits / 8;
      const pxRate = cl.w * cl.h * cl.fps;
      const bpp = pxRate > 0 ? videoBits / pxRate : NaN;
      const targetBytes = bps * targetSec;
      const recordMin = m.usable / bps / 60;
      const writeMBps = bps / 1e6;
      const ratio = recordMin / num(c.targetMinutes);
      const writeOk = num(c.gradeMBps) > 0 ? writeMBps <= num(c.gradeMBps) + 1e-9 : null;
      const uploadMin = upBytesPerSec > 0 ? targetBytes / upBytesPerSec / 60 : null;
      return {
        idx: i, name: cl.name, w: cl.w, h: cl.h, fps: cl.fps, rateUnit: cl.rateUnit, rate: cl.rate, codec: cl.codec,
        videoBits, audioBits, totalBits, bps, bpp, pxRate,
        mbPerMin: bps * 60 / 1e6, gbPerHour: bps * 3600 / GB_DEC,
        targetBytes, targetGB: targetBytes / GB_DEC, targetGiB: targetBytes / GIB_BIN,
        recordMin, recordSec: recordMin * 60, writeMBps, writeOk, ratio, uploadMin,
        verdict: verdictOf(ratio, writeOk),
        gradeNeed: gradeLabel(writeMBps)
      };
    });

    const sel = clips[selIdx];
    const sourceMin = num(c.targetMinutes) * num(c.shootRatio) * num(c.cameras);
    const sourceBytes = sel.bps * sourceMin * 60;
    const proxyBytes = num(c.proxyMbps) > 0 ? num(c.proxyMbps) * 1e6 / 8 * sourceMin * 60 : 0;
    const deliveryBytes = sel.targetBytes;
    const projectBytes = sourceBytes + proxyBytes + deliveryBytes;
    const cardsNeeded = m.usable > 0 ? Math.ceil(round(projectBytes / m.usable, 9)) : null;

    const rev = {
      reqCapacityBytes: sel.targetBytes / (num(c.usablePct) / 100),
      reqGradeMBps: sel.writeMBps,
      reqGradeV: gradeLabel(sel.writeMBps),
      reqUploadMbps: (sel.targetBytes / (num(c.targetUploadMinutes) * 60)) * 8 / 1e6 / (num(c.uploadUtilPct) / 100),
      reqRateMbpsForBpp: num(c.bppRef) * sel.pxRate / 1e6,
      targetCapacityBytes: sel.targetBytes
    };
    rev.reqCapacity = rev.reqCapacityBytes / m.unitBytes;
    rev.capacityShortGB = Math.max(0, rev.reqCapacityBytes - m.total) / GB_DEC;
    rev.uploadOverMin = sel.uploadMin === null ? null : sel.uploadMin - num(c.targetUploadMinutes);

    const res = {
      cfg: c, clips, selIdx, sel, media: m,
      targetSec, targetMinutes: num(c.targetMinutes),
      audioBits, overhead, upBytesPerSec,
      sourceMin, sourceBytes, proxyBytes, deliveryBytes, projectBytes, cardsNeeded,
      rev,
      scenario: c.label
    };
    res.checks = selfChecks(res);
    res.checkSummary = {
      total: res.checks.length,
      pass: res.checks.filter((x) => x.pass).length,
      fail: res.checks.filter((x) => !x.pass).length
    };
    return res;
  }

  /* ── 结构自检（每次重算都跑，项数恒定 18） ───────────── */
  function selfChecks(res) {
    const c = res.cfg;
    const out = [];
    const push = (name, pass, detail) => out.push({ name, pass: !!pass, detail: detail === undefined ? '' : String(detail) });
    const near = (a, b, tol) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= (tol === undefined ? 1e-6 : tol) * Math.max(1, Math.abs(a), Math.abs(b));
    const allClips = res.clips;

    // 1 每秒占用 = (视频 + 音频) × 开销 ÷ 8
    push('每秒占用 = (视频比特率 + 音频比特率) × (1 + 封装开销) ÷ 8',
      allClips.every((k) => near(k.bps, (k.videoBits + audioBitsOf(res)) * res.overhead / 8)),
      fmtMBps(res.sel.bps));

    // 2 目标文件 = 每秒占用 × 目标秒数
    push('目标文件字节 = 每秒占用 × 目标秒数',
      allClips.every((k) => near(k.targetBytes, k.bps * res.targetSec)),
      fmtBytes(res.sel.targetBytes));

    // 3 可录时长 = 可用字节 ÷ 每秒占用 ÷ 60
    push('可录时长 = 介质可用字节 ÷ 每秒占用 ÷ 60',
      allClips.every((k) => near(k.recordMin, res.media.usable / k.bps / 60, 1e-9)),
      fmtDur(res.sel.recordMin));

    // 4 判定与 ratio / 写入速度一致
    const verdictOk = allClips.every((k) => {
      const want = verdictOf(k.ratio, k.writeOk);
      return want.id === k.verdict.id;
    });
    push('判定与「可录时长 ÷ 目标时长」及写入速度一致', verdictOk,
      res.sel.verdict.label + '（ratio ' + fmtNum(res.sel.ratio, 3) + '）');

    // 5 bpp = 视频码率 ÷ 像素率
    push('bpp = 视频比特率 ÷ (宽 × 高 × 帧率)',
      allClips.every((k) => (k.pxRate > 0 ? near(k.bpp, k.videoBits / k.pxRate, 1e-9) : !Number.isFinite(k.bpp))),
      fmtBpp(res.sel.bpp) + ' bit/像素/帧');

    // 6 写入需求 = 每秒占用 ÷ 1e6
    push('写入需求 MB/s = 每秒占用 ÷ 10^6',
      allClips.every((k) => near(k.writeMBps, k.bps / 1e6, 1e-9)),
      fmtMBps(res.sel.bps));

    // 7 十进制 GB 与二进制 GiB 的换算关系成立
    const rel = Math.abs(res.sel.targetGB / res.sel.targetGiB - GIB_BIN / GB_DEC);
    push('GB 与 GiB 的换算关系成立（1 GiB = 1.0737 GB）', rel < 1e-9 && res.sel.targetGB > res.sel.targetGiB,
      fmtGB(res.sel.targetBytes) + ' = ' + fmtGiB(res.sel.targetBytes));

    // 8 介质可用字节 = 容量 × 进制系数 × 可用比例
    const unitB = c.capacityUnit === 'GiB' ? GIB_BIN : GB_DEC;
    push('介质可用字节 = 标称容量 × 进制系数 × 可用比例',
      near(res.media.total, c.capacity * unitB) && near(res.media.usable, res.media.total * c.usablePct / 100),
      fmtBytesBoth(res.media.usable));

    // 9 项目总字节 = 素材 + 代理 + 成片
    push('项目总字节 = 素材 + 代理 + 成片',
      near(res.projectBytes, res.sourceBytes + res.proxyBytes + res.deliveryBytes),
      fmtBytes(res.projectBytes));

    // 10 卡张数最优：少一张装不下
    const cards = res.cardsNeeded;
    const cardOk = Number.isFinite(cards) && cards >= 1
      && cards * res.media.usable + 1e-6 >= res.projectBytes
      && (cards - 1) * res.media.usable < res.projectBytes - 1e-6;
    push('所需卡张数最优（少一张就装不下）', cardOk,
      cards + ' 张 × ' + fmtBytes(res.media.usable));

    // 11 上传时长 = 文件字节 ÷ 有效上行速率（带宽 0 → null 而不是无穷）
    const upOk = res.upBytesPerSec > 0
      ? allClips.every((k) => near(k.uploadMin, k.targetBytes / res.upBytesPerSec / 60, 1e-9))
      : allClips.every((k) => k.uploadMin === null);
    push('上传时长 = 文件字节 ÷ 有效上行速率（带宽 0 时记「不可计算」）', upOk,
      res.sel.uploadMin === null ? '不可计算（带宽或利用率为 0）' : fmtDur(res.sel.uploadMin));

    // 12 反推容量回代：能覆盖目标时长
    const backMin = res.rev.reqCapacityBytes / res.sel.bps / 60;
    push('反推容量回代后能覆盖目标时长', backMin >= res.targetMinutes - 1e-6,
      fmtGB(res.rev.reqCapacityBytes) + ' → ' + fmtDur(backMin));

    // 13 反推带宽回代：能达到目标上传时长
    const backUp = res.rev.reqUploadMbps * 1e6 / 8 * (c.uploadUtilPct / 100);
    const backUpMin = backUp > 0 ? res.sel.targetBytes / backUp / 60 : NaN;
    push('反推带宽回代后能在期望时间内传完', near(backUpMin, c.targetUploadMinutes, 1e-9),
      fmtMbps(res.rev.reqUploadMbps) + ' → ' + fmtDur(backUpMin));

    // 14 反推码率回代：bpp ≥ 参考下限
    const backBpp = res.rev.reqRateMbpsForBpp * 1e6 / res.sel.pxRate;
    push('反推码率回代后 bpp ≥ 参考下限', backBpp >= c.bppRef - 1e-9,
      fmtBpp(backBpp) + '（参考下限 ' + fmtBpp(c.bppRef) + '）');

    // 15 单调性：码率 +1% → 可录时长严格变短、目标文件变大
    const up1 = quickRate(Object.assign({}, c, { clips: c.clips.map((k, i) => i === res.selIdx ? Object.assign({}, k, { rate: k.rate * 1.01 }) : k) }), res.selIdx);
    const m1 = res.media.usable / up1.bps / 60;
    push('单调性：码率 +1% → 可录时长严格变短、目标文件变大',
      m1 < res.sel.recordMin && up1.bps * res.targetSec > res.sel.targetBytes,
      fmtDur(res.sel.recordMin) + ' → ' + fmtDur(m1));

    // 16 单调性：容量 +1% → 可录时长严格变长
    const bigUsable = res.media.usable * 1.01;
    push('单调性：介质容量 +1% → 可录时长严格变长',
      bigUsable / res.sel.bps / 60 > res.sel.recordMin,
      fmtDur(res.sel.recordMin) + ' → ' + fmtDur(bigUsable / res.sel.bps / 60));

    // 17 单位不变性：Mbps 与 MB/s 的等价写法给出逐位相同的每秒占用
    const altRate = res.sel.rateUnit === 'Mbps' ? res.sel.rate / 8 : res.sel.rate * 8;
    const altUnit = res.sel.rateUnit === 'Mbps' ? 'MB/s' : 'Mbps';
    const altCfg = Object.assign({}, c, {
      clips: c.clips.map((k, i) => i === res.selIdx ? Object.assign({}, k, { rateUnit: altUnit, rate: altRate }) : k)
    });
    const alt = quickRate(altCfg, res.selIdx);
    push('单位不变性：' + res.sel.rateUnit + ' ↔ ' + altUnit + ' 的等价写法给出相同的每秒占用',
      near(alt.bps, res.sel.bps, 1e-12),
      fmtNum(altRate, 4) + ' ' + altUnit + ' → ' + fmtMBps(alt.bps));

    // 18 所有数值字段有限或明确为 null
    const fields = [];
    res.clips.forEach((k) => {
      fields.push(k.bps, k.bpp, k.targetBytes, k.recordMin, k.writeMBps, k.ratio, k.mbPerMin, k.gbPerHour, k.totalBits,
        k.videoBits, k.audioBits, k.pxRate);
      if (k.uploadMin !== null) fields.push(k.uploadMin);
    });
    fields.push(res.media.total, res.media.usable, res.projectBytes, res.sourceBytes, res.proxyBytes, res.deliveryBytes,
      res.rev.reqCapacityBytes, res.rev.reqUploadMbps, res.rev.reqRateMbpsForBpp, res.sourceMin, res.upBytesPerSec,
      res.targetSec, res.targetMinutes, res.cfg.capacity);
    const nulls = [res.sel.bpp].filter((x) => x === null);
    const finite = fields.every((x) => Number.isFinite(x)) && nulls.length === 0;
    const bad = fields.filter((x) => !Number.isFinite(x));
    push('所有数值字段都是有限数（没有非数 / 无穷大）', finite,
      '检查 ' + fields.length + ' 个字段' + (bad.length ? '，异常 ' + bad.length + ' 个' : ''));

    return out;
  }
  function audioBitsOf(res) { return res.audioBits; }

  /* ── 敏感性（每行完整重算） ───────────── */
  function sensitivity(cfg) {
    const c = normCfg(cfg);
    const res = analyze(c);
    const sel = res.sel;
    const withClip = (over) => Object.assign({}, c, {
      clips: c.clips.map((k, i) => i === res.selIdx ? Object.assign({}, k, over) : k)
    });
    const rows = [
      { name: '选中档位码率 +20%', cfg: withClip({ rate: sel.rate * 1.2 }) },
      { name: '选中档位码率 −20%', cfg: withClip({ rate: sel.rate * 0.8 }) },
      { name: '帧率翻倍（' + fmtNum(sel.fps, 0) + ' → ' + fmtNum(sel.fps * 2, 0) + ' fps）', cfg: withClip({ fps: sel.fps * 2 }) },
      { name: '分辨率减半（宽高各 ÷√2）', cfg: withClip({ w: Math.round(sel.w / Math.SQRT2), h: Math.round(sel.h / Math.SQRT2) }) },
      { name: '封装开销 +2 个百分点', cfg: Object.assign({}, c, { overheadPct: c.overheadPct + 2 }) },
      { name: '可用比例降到 85%', cfg: Object.assign({}, c, { usablePct: 85 }) },
      { name: '介质容量 +64 GB', cfg: Object.assign({}, c, { capacity: c.capacity + (c.capacityUnit === 'GiB' ? 60 : 64) }) },
      { name: '上行带宽 ×1.5', cfg: Object.assign({}, c, { uploadMbps: c.uploadMbps * 1.5 }) },
      { name: '上行带宽 ÷2', cfg: Object.assign({}, c, { uploadMbps: c.uploadMbps / 2 }) },
      { name: '音轨 2 → 1', cfg: Object.assign({}, c, { audioTracks: 1 }) },
      { name: '素材倍率 +1', cfg: Object.assign({}, c, { shootRatio: c.shootRatio + 1 }) },
      { name: '机位 +1', cfg: Object.assign({}, c, { cameras: c.cameras + 1 }) }
    ];
    return rows.map((r) => {
      const q = quickRate(r.cfg, res.selIdx);
      const med = mediaBytes(r.cfg);
      const recMin = med.usable / q.bps / 60;
      const ratio = recMin / r.cfg.targetMinutes;
      const writeOk = r.cfg.gradeMBps > 0 ? q.writeMBps <= r.cfg.gradeMBps + 1e-9 : null;
      const tBytes = q.bps * r.cfg.targetMinutes * 60;
      const upBytes = r.cfg.uploadMbps * 1e6 / 8 * (r.cfg.uploadUtilPct / 100);
      const srcMin = r.cfg.targetMinutes * r.cfg.shootRatio * r.cfg.cameras;
      const projBytes = q.bps * srcMin * 60 + (r.cfg.proxyMbps > 0 ? r.cfg.proxyMbps * 1e6 / 8 * srcMin * 60 : 0) + tBytes;
      const cards = med.usable > 0 ? Math.ceil(round(projBytes / med.usable, 9)) : null;
      return {
        name: r.name,
        writeMBps: q.writeMBps,
        targetGB: tBytes / GB_DEC,
        recordMin: recMin,
        usableBytes: med.usable,
        uploadMin: upBytes > 0 ? tBytes / upBytes / 60 : null,
        cards,
        bpp: q.bpp,
        verdict: verdictOf(ratio, writeOk),
        ratio
      };
    });
  }

  /* ── 要记住的几条（数字全部来自同一次计算结果） ───────── */
  function insights(res) {
    const c = res.cfg;
    const sel = res.sel;
    const out = [];
    const byBpp = res.clips.slice().filter((k) => Number.isFinite(k.bpp)).sort((a, b) => a.bpp - b.bpp);

    // 1 单位陷阱
    const trueHour = sel.bps * 3600;
    const mistakenHour = sel.rate * 1e6 * 3600; // 把码率的数字直接当成 MB/s
    out.push({
      title: '码率的「Mbps」与存储的「MB/s」差 8 倍：' + fmtNum(sel.rate, 2) + ' ' + sel.rateUnit + ' 每秒写 ' + fmtMBps(sel.bps),
      text: '这个档位每小时占 ' + fmtGB(trueHour) + '（' + fmtGiB(trueHour) + '）；如果把 ' + fmtNum(sel.rate, 2) + ' 直接当成 '
        + fmtNum(sel.rate, 2) + ' MB/s 去乘时长，会算成 ' + fmtGB(mistakenHour) + '，是真实值的 ' + fmtNum(mistakenHour / trueHour, 2)
        + ' 倍。相机界面、剪辑软件、网盘常常一个用 Mbps、一个用 MB/s，这是这类账最容易错的一处。'
    });

    // 2 容量口径
    const unitName = c.capacityUnit;
    out.push({
      title: '标称 ' + fmtNum(c.capacity, 0) + ' ' + unitName + ' 的介质，换个口径就是另一个数',
      text: (unitName === 'GB'
        ? '厂商按 10^9 卖、系统按 2^30 显示：' + fmtNum(c.capacity, 0) + ' GB = ' + fmtNum(res.media.total / GIB_BIN, 2)
          + ' GiB，所以在电脑上看只有 ' + fmtNum(res.media.total / GIB_BIN, 2) + '「GB」——这是口径差，不是虚标（差 '
          + fmtPct((GIB_BIN / GB_DEC - 1) * 100, 2) + '）。'
        : '你填的是二进制口径：' + fmtNum(c.capacity, 0) + ' GiB = ' + fmtNum(res.media.total / GB_DEC, 2)
          + ' GB，相当于厂商口径标称 ' + fmtNum(res.media.total / GB_DEC, 1) + ' GB。')
        + '再乘上你填的可用比例 ' + fmtPct(c.usablePct, 0) + '，真正能写进去的是 ' + fmtBytesBoth(res.media.usable, 2) + '。'
    });

    // 3 bpp 对照
    if (byBpp.length >= 2) {
      const lo = byBpp[0], hi = byBpp[byBpp.length - 1];
      out.push({
        title: '档位名字里的分辨率，跟「每像素拿到多少比特」不是一回事',
        text: '这几档里每像素最薄的是「' + (lo.name || '第 ' + (lo.idx + 1) + ' 档') + '」（' + lo.w + '×' + lo.h + ' @ ' + fmtNum(lo.fps, 0)
          + ' fps、' + fmtNum(lo.rate, 0) + ' ' + lo.rateUnit + '）只有 ' + fmtBpp(lo.bpp) + ' bit/像素/帧；最厚的是「'
          + (hi.name || '第 ' + (hi.idx + 1) + ' 档') + '」的 ' + fmtBpp(hi.bpp) + '，是前者的 ' + fmtNum(hi.bpp / lo.bpp, 2)
          + ' 倍。同样标着 4K 的档位之间也可能差很多，bpp 只用来横向比，本页不拿它当画质评分。'
      });
    }

    // 4 写入 vs 卡速
    if (sel.writeOk === null) {
      out.push({
        title: '卡速没填，这张卡只判了容量',
        text: '写入需求是 ' + fmtMBps(sel.bps) + '（平均码率口径）。凭经验把卡速填上（V6=6、V10=10、V30=30、V60=60、V90=90 MB/s），页面才会告诉你掉不掉帧。'
      });
    } else {
      const gradePart = sel.gradeNeed ? ('最低要 ' + sel.gradeNeed + ' 级') : '已超出常见 V 等级（V90 = 90 MB/s）';
      const detail = sel.gradeNeed
        ? ('等级数就是保证的最低持续写入速度：需求 ' + fmtMBps(sel.bps) + ' 对应 ' + sel.gradeNeed + '；当前标的 '
          + fmtNum(c.gradeMBps, 0) + ' MB/s，余量 ' + fmtNum(c.gradeMBps / sel.writeMBps, 2) + ' 倍。')
        : ('需求 ' + fmtMBps(sel.bps) + ' 已超过 V90 的 90 MB/s，普通 SD 卡基本无解，要换更高等级的介质。');
      out.push({
        title: '写入需求 ' + fmtMBps(sel.bps) + '：' + (sel.writeOk ? '卡速够' : '卡速不够') + '，' + gradePart,
        text: detail + '注意这是平均码率，现场峰值与温度掉速会更高，别把「刚好达标」当安全。'
      });
    }

    // 5 素材与卡张数
    out.push({
      title: '成片 ' + fmtDur(c.targetMinutes) + '，素材要拍 ' + fmtDur(res.sourceMin) + '（' + fmtNum(c.shootRatio, 0) + ' 倍素材 × ' + fmtNum(c.cameras, 0) + ' 机位）',
      text: '素材 ' + fmtBytes(res.sourceBytes) + (res.proxyBytes > 0 ? '、代理 ' + fmtBytes(res.proxyBytes) : '')
        + '、成片 ' + fmtBytes(res.deliveryBytes) + '，合计 ' + fmtBytesBoth(res.projectBytes, 1) + ' ≈ ' + res.cardsNeeded
        + ' 张当前介质的全部可用空间。只按成片大小买卡，会差 ' + fmtNum(res.projectBytes / res.deliveryBytes, 2) + ' 倍。'
    });

    // 6 上传与备份
    if (sel.uploadMin === null) {
      out.push({
        title: '上行带宽填的是 0，上传时长不可计算',
        text: '页面不会拿无穷大糊弄你：把上行带宽与利用率填上，才会出现上传账。'
      });
    } else {
      out.push({
        title: '传这 ' + fmtBytes(sel.targetBytes) + ' 要 ' + fmtDur(sel.uploadMin) + '（期望 ' + fmtDur(c.targetUploadMinutes) + '）',
        text: '按 ' + fmtMbps(c.uploadMbps) + ' × ' + fmtPct(c.uploadUtilPct, 0) + ' 利用率算，想按时传完需要 ' + fmtMbps(res.rev.reqUploadMbps)
          + '；素材全传一遍就是 ' + fmtDur(res.projectBytes / res.upBytesPerSec / 60) + '，再加一份备份就再翻一倍。'
      });
    }
    return out;
  }

  /* ── 下一步（每条都能一键改回输入） ───────────── */
  function steps(res) {
    const c = res.cfg;
    const sel = res.sel;
    const out = [];

    if (sel.recordMin < c.targetMinutes) {
      const needCap = Math.ceil(res.rev.reqCapacity);
      out.push({
        title: '把介质容量加到 ' + fmtNum(needCap, 0) + ' ' + c.capacityUnit + '（现在 ' + fmtNum(c.capacity, 0) + '）',
        text: '要录满 ' + fmtDur(c.targetMinutes) + '，按可用比例 ' + fmtPct(c.usablePct, 0) + ' 至少要 ' + fmtBytesBoth(res.rev.reqCapacityBytes)
          + '；现在只能录 ' + fmtDur(sel.recordMin) + '，还差 ' + fmtDur(c.targetMinutes - sel.recordMin) + '。',
        patch: { scope: 'cfg', values: { capacity: needCap } }
      });
    } else if (sel.ratio < 1.2) {
      const needCap = Math.ceil(res.rev.reqCapacity * 1.2);
      out.push({
        title: '余量只有 ' + fmtPct((sel.ratio - 1) * 100, 1) + '：建议留到 20% 以上',
        text: '要留 20% 余量需要 ' + fmtBytesBoth(res.rev.reqCapacityBytes * 1.2) + '，也就是 ' + fmtNum(needCap, 0)
          + ' ' + c.capacityUnit + ' 起。现场多拍几条、忘删废条都会吃掉这点余量。',
        patch: { scope: 'cfg', values: { capacity: needCap } }
      });
    }

    if (sel.writeOk === false) {
      const need = ceilTo(sel.writeMBps, 0.5);
      const fitRate = Math.max(0, c.gradeMBps * 8 / (1 + c.overheadPct / 100) - (c.audioKbps * c.audioTracks) / 1000);
      out.push({
        title: '换一张最低持续写入 ≥ ' + fmtNum(need, 1) + ' MB/s 的介质' + (sel.gradeNeed ? '（' + sel.gradeNeed + ' 级）' : '（超出 V90）'),
        text: '当前档位平均写入需求 ' + fmtMBps(sel.bps) + '，卡上标的 ' + fmtNum(c.gradeMBps, 0) + ' MB/s 不够；'
          + (fitRate > 0 ? '或者把码率降到 ' + fmtNum(fitRate, 1) + ' Mbps 以下也能塞进这张卡。' : '把码率降到这张卡能吃的水平已经不可能，只能换卡。'),
        patch: { scope: 'cfg', values: { gradeMBps: need } }
      });
    }

    const upPerSec = res.upBytesPerSec;
    if (sel.uploadMin !== null && sel.uploadMin > c.targetUploadMinutes) {
      out.push({
        title: '上行带宽至少要 ' + fmtMbps(res.rev.reqUploadMbps) + '（现在 ' + fmtMbps(c.uploadMbps) + '）',
        text: '想在 ' + fmtDur(c.targetUploadMinutes) + ' 内传完 ' + fmtBytes(sel.targetBytes) + '，按 ' + fmtPct(c.uploadUtilPct, 0)
          + ' 利用率需要 ' + fmtMbps(res.rev.reqUploadMbps) + '；现在要 ' + fmtDur(sel.uploadMin) + '。',
        patch: { scope: 'cfg', values: { uploadMbps: ceilTo(res.rev.reqUploadMbps, 1) } }
      });
    } else if (sel.uploadMin === null && upPerSec === 0) {
      out.push({
        title: '先填上行带宽与利用率，上传账才算得出来',
        text: '带宽或利用率是 0 时页面显示「—」，不会给你一个无穷大的时间。',
        patch: { scope: 'cfg', values: { uploadMbps: 100, uploadUtilPct: 80 } }
      });
    }

    if (Number.isFinite(sel.bpp) && c.bppRef > 0 && sel.bpp < c.bppRef) {
      const needMbps = ceilTo(res.rev.reqRateMbpsForBpp, 0.1);
      const patch = { scope: 'clip', idx: res.selIdx, values: sel.rateUnit === 'Mbps' ? { rate: needMbps } : { rate: round(needMbps / 8, 4) } };
      const shown = sel.rateUnit === 'Mbps' ? fmtMbps(needMbps) : fmtNum(round(needMbps / 8, 4), 4) + ' MB/s';
      out.push({
        title: '要让 bpp 回到参考下限 ' + fmtBpp(c.bppRef) + '，码率至少要 ' + shown,
        text: '当前「' + (sel.name || '选中档位') + '」的 bpp 是 ' + fmtBpp(sel.bpp) + '，低于你自己划的参考下限；上调码率会让文件大小与容量需求同比变大。',
        patch
      });
    }

    if (res.cardsNeeded > 1) {
      out.push({
        title: '素材要 ' + res.cardsNeeded + ' 张卡（或拍完立刻倒到硬盘）',
        text: '素材 + 代理 + 成片合计 ' + fmtBytesBoth(res.projectBytes, 1) + '，单张可用 ' + fmtBytesBoth(res.media.usable, 1)
          + '，装不下就得再买 ' + (res.cardsNeeded - 1) + ' 张。',
        patch: null
      });
    }

    if (res.clips.length > 1 && Number.isFinite(sel.bpp)) {
      const thinnest = res.clips.slice().filter((k) => Number.isFinite(k.bpp)).sort((a, b) => a.bpp - b.bpp)[0];
      if (thinnest && thinnest.idx !== res.selIdx && thinnest.bpp < sel.bpp) {
        out.push({
          title: '换成「' + (thinnest.name || '第 ' + (thinnest.idx + 1) + ' 档') + '」每像素比特更低，但更省卡',
          text: '它的 bpp 是 ' + fmtBpp(thinnest.bpp) + '（选中档 ' + fmtBpp(sel.bpp) + '），可录时长 '
            + fmtDur(thinnest.recordMin) + '（选中档 ' + fmtDur(sel.recordMin) + '）。这是权衡，不是推荐。',
          patch: { scope: 'cfg', values: { pickedIdx: thinnest.idx } }
        });
      }
    }
    return out.slice(0, 5);
  }

  /* ── 导出 ───────────────────────────── */
  function backupJson(cfg) {
    return JSON.stringify({ app: SLUG, name: NAME, version: VERSION, savedAt: new Date().toISOString(), cfg: normCfg(cfg) }, null, 2);
  }
  function readBackup(text) {
    let o;
    try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return { ok: false, error: '不是合法的 JSON：' + e.message, cfg: null }; }
    if (!o || typeof o !== 'object') return { ok: false, error: '备份内容不是对象', cfg: null };
    if (o.app && o.app !== SLUG) return { ok: false, error: '这份备份来自「' + o.app + '」，不是本页的备份', cfg: null };
    const src = o.cfg && typeof o.cfg === 'object' ? o.cfg : o;
    if (!src || typeof src !== 'object' || !Array.isArray(src.clips) || !src.clips.length) {
      return { ok: false, error: '备份里没有可用的档位数组（clips）', cfg: null };
    }
    const cfg = normCfg(src);
    const v = validate(cfg);
    if (!v.ok) return { ok: false, error: '备份里的数据没通过校验：' + v.errors[0].msg, cfg: null };
    return { ok: true, error: '', cfg };
  }

  function toCsv(cfg) {
    const res = analyze(cfg);
    const L = [];
    const q = (s) => '"' + String(s).replace(/"/g, '""') + '"';
    L.push(['分区', '项目', '数值', '单位或说明'].map(q).join(','));
    const row = (a, b, c, d) => L.push([a, b, c, d].map(q).join(','));
    res.clips.forEach((k) => {
      row('档位账', k.name || '第 ' + (k.idx + 1) + ' 档', fmtNum(k.rate, 2), k.rateUnit + ' · ' + k.w + '×' + k.h + ' @ ' + fmtNum(k.fps, 0) + ' fps · ' + k.codec);
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 每秒占用', fmtNum(k.bps / 1e6, 4), 'MB/s');
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 每分钟占用', fmtNum(k.mbPerMin, 2), 'MB/分钟');
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 目标文件', fmtNum(k.targetGB, 4), 'GB（十进制）');
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 可录时长', fmtNum(k.recordMin, 2), '分钟');
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 写入需求', fmtNum(k.writeMBps, 3), 'MB/s');
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' bpp', fmtNum(k.bpp, 4), 'bit/像素/帧');
      row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 判定', k.verdict.label, k.verdict.why);
      if (k.uploadMin !== null) row('档位账', (k.name || '第 ' + (k.idx + 1) + ' 档') + ' 上传时长', fmtNum(k.uploadMin, 2), '分钟');
    });
    row('介质', '标称容量', fmtNum(res.cfg.capacity, 4), res.cfg.capacityUnit);
    row('介质', '介质总字节', fmtNum(res.media.total, 0), '字节');
    row('介质', '可用字节', fmtNum(res.media.usable, 0), '字节');
    row('介质', '可用字节（GiB 显示）', fmtNum(res.media.usable / GIB_BIN, 2), 'GiB');
    row('目标', '目标时长', fmtNum(res.targetMinutes, 2), '分钟');
    row('目标', '选中档位文件大小', fmtNum(res.sel.targetGB, 4), 'GB');
    row('目标', '选中档位可录时长', fmtNum(res.sel.recordMin, 2), '分钟');
    row('素材', '素材时长', fmtNum(res.sourceMin, 2), '分钟');
    row('素材', '素材字节', fmtNum(res.sourceBytes, 0), '字节');
    row('素材', '代理字节', fmtNum(res.proxyBytes, 0), '字节');
    row('素材', '成片字节', fmtNum(res.deliveryBytes, 0), '字节');
    row('素材', '项目总字节', fmtNum(res.projectBytes, 0), '字节');
    row('素材', '需要卡张数', String(res.cardsNeeded), '张');
    row('上传', '有效上行速率', fmtNum(res.upBytesPerSec / 1e6, 4), 'MB/s');
    if (res.sel.uploadMin !== null) row('上传', '选中档位上传时长', fmtNum(res.sel.uploadMin, 2), '分钟');
    else row('上传', '选中档位上传时长', '不可计算', '带宽或利用率为 0');
    row('反推', '录满目标时长所需容量', fmtNum(res.rev.reqCapacity, 4), res.cfg.capacityUnit);
    row('反推', '达到期望上传时间所需带宽', fmtNum(res.rev.reqUploadMbps, 3), 'Mbps');
    row('反推', '达到参考 bpp 所需码率', fmtNum(res.rev.reqRateMbpsForBpp, 3), 'Mbps');
    row('反推', '写入达标所需卡速', fmtNum(res.rev.reqGradeMBps, 3), 'MB/s' + (res.rev.reqGradeV ? '（' + res.rev.reqGradeV + '）' : '（超出 V90）'));
    sensitivity(res.cfg).forEach((r) => {
      row('敏感性', r.name, fmtNum(r.writeMBps, 3), 'MB/s · 可录 ' + fmtNum(r.recordMin, 1) + ' 分钟 · ' + r.verdict.label
        + (r.uploadMin === null ? ' · 上传不可计算' : ' · 上传 ' + fmtNum(r.uploadMin, 1) + ' 分钟'));
    });
    res.checks.forEach((x) => row('结构自检', x.name, x.pass ? '通过' : '不通过', x.detail));
    return L.join('\n');
  }

  function toMd(cfg) {
    const res = analyze(cfg);
    const c = res.cfg;
    const L = [];
    L.push('# ' + NAME + ' · ' + (c.label || '未命名拍摄'));
    L.push('');
    L.push('> 生成时间 ' + new Date().toISOString() + '；码率、容量、带宽与比例全部来自你填的数字，页面不联网、不查机型规格。');
    L.push('');
    L.push('## 结论');
    L.push('- 判定：' + res.sel.verdict.label + '（' + res.sel.verdict.why + '）');
    L.push('- 选中档位：' + (res.sel.name || '第 ' + (res.selIdx + 1) + ' 档') + ' · ' + res.sel.w + '×' + res.sel.h + ' @ '
      + fmtNum(res.sel.fps, 0) + ' fps · ' + fmtNum(res.sel.rate, 2) + ' ' + res.sel.rateUnit);
    L.push('- 每秒占用 ' + fmtMBps(res.sel.bps) + '；每分钟 ' + fmtNum(res.sel.mbPerMin, 1) + ' MB；每小时 ' + fmtGB(res.sel.bps * 3600));
    L.push('- 目标 ' + fmtDur(res.targetMinutes) + ' 的文件 ' + fmtBytesBoth(res.sel.targetBytes));
    L.push('- 介质可用 ' + fmtBytesBoth(res.media.usable) + '，可录 ' + fmtDur(res.sel.recordMin) + '（余量 ' + fmtPct((res.sel.ratio - 1) * 100, 1) + '）');
    L.push('- 写入需求 ' + fmtMBps(res.sel.bps) + '（' + (res.sel.writeOk === null ? '卡速未填，未判定' : res.sel.writeOk ? '卡速够' : '卡速不够') + '）');
    L.push('- bpp ' + fmtBpp(res.sel.bpp) + ' bit/像素/帧');
    L.push('- 上传 ' + (res.sel.uploadMin === null ? '不可计算（带宽或利用率为 0）' : fmtDur(res.sel.uploadMin)));
    L.push('');
    L.push('## 档位账');
    L.push('| 档位 | 分辨率 | 帧率 | 码率 | 每秒 MB | 目标文件 | 可录时长 | 写入需求 | bpp | 判定 |');
    L.push('|---|---|---|---|---|---|---|---|---|---|');
    res.clips.forEach((k) => {
      L.push('| ' + (k.name || '第 ' + (k.idx + 1) + ' 档') + ' | ' + k.w + '×' + k.h + ' | ' + fmtNum(k.fps, 0)
        + ' | ' + fmtNum(k.rate, 2) + ' ' + k.rateUnit + ' | ' + fmtNum(k.bps / 1e6, 3) + ' | ' + fmtGB(k.targetBytes)
        + ' | ' + fmtDur(k.recordMin) + ' | ' + fmtNum(k.writeMBps, 2) + ' MB/s | ' + fmtBpp(k.bpp) + ' | ' + k.verdict.label + ' |');
    });
    L.push('');
    L.push('## 素材、卡与上传');
    L.push('- 素材时长 ' + fmtDur(res.sourceMin) + '（' + fmtNum(c.shootRatio, 0) + ' 倍素材 × ' + fmtNum(c.cameras, 0) + ' 机位）');
    L.push('- 素材 ' + fmtBytes(res.sourceBytes) + '；代理 ' + fmtBytes(res.proxyBytes) + '；成片 ' + fmtBytes(res.deliveryBytes));
    L.push('- 项目总字节 ' + fmtBytesBoth(res.projectBytes) + ' ≈ ' + res.cardsNeeded + ' 张当前介质');
    L.push('- 有效上行速率 ' + fmtMBps(res.upBytesPerSec) + '；选中档位上传 '
      + (res.sel.uploadMin === null ? '不可计算' : fmtDur(res.sel.uploadMin)));
    L.push('');
    L.push('## 反推');
    L.push('- 要录满 ' + fmtDur(res.targetMinutes) + '：介质容量至少 ' + fmtNum(res.rev.reqCapacity, 2) + ' ' + c.capacityUnit
      + '（' + fmtBytesBoth(res.rev.reqCapacityBytes) + '）');
    L.push('- 要在 ' + fmtDur(c.targetUploadMinutes) + ' 内传完：上行至少 ' + fmtMbps(res.rev.reqUploadMbps));
    L.push('- 要达到参考 bpp ' + fmtBpp(c.bppRef) + '：码率至少 ' + fmtMbps(res.rev.reqRateMbpsForBpp));
    L.push('- 写入达标：最低持续写入 ' + fmtNum(res.rev.reqGradeMBps, 2) + ' MB/s'
      + (res.rev.reqGradeV ? '（' + res.rev.reqGradeV + '）' : '（超出 V90，需要更高等级的介质）'));
    L.push('');
    L.push('## 敏感性（每行完整重算，不是插值）');
    L.push('| 改法 | 每秒 MB | 目标文件 | 可录时长 | 上传 | 卡张数 | bpp | 判定 |');
    L.push('|---|---|---|---|---|---|---|---|');
    sensitivity(c).forEach((r) => {
      L.push('| ' + r.name + ' | ' + fmtNum(r.writeMBps, 3) + ' | ' + fmtGB(r.targetGB * GB_DEC) + ' | ' + fmtDur(r.recordMin)
        + ' | ' + (r.uploadMin === null ? '—' : fmtDur(r.uploadMin)) + ' | ' + r.cards + ' | ' + fmtBpp(r.bpp) + ' | ' + r.verdict.label + ' |');
    });
    L.push('');
    L.push('## 结构自检 ' + res.checkSummary.pass + '/' + res.checkSummary.total);
    res.checks.forEach((x) => L.push('- [' + (x.pass ? 'x' : ' ') + '] ' + x.name + (x.detail ? '（' + x.detail + '）' : '')));
    L.push('');
    L.push('> 本页只做算术：码率按恒定处理，不建模 VBR 波动、掉速曲线、文件系统开销与平台限速；'
      + 'bpp 只用于档位之间横向比较，不是画质评分。');
    return L.join('\n');
  }

  const api = {
    slug: SLUG, name: NAME, version: VERSION,
    CLIP_MIN, CLIP_MAX, CODECS, RATE_UNITS, CAP_UNITS, V_GRADES, CHECK_TOTAL,
    GB_DEC, GIB_BIN,
    defaults, defaultsClone, scenarios, scenarioCfg, normCfg, validate, analyze,
    sensitivity, insights, steps, selfChecks, quickRate, mediaBytes, verdictOf, gradeLabel,
    backupJson, readBackup, toCsv, toMd,
    num, clampNum, sum, round, ceilTo,
    fmtNum, fmtInt, fmtPct, fmtBytes, fmtGB, fmtGiB, fmtBytesBoth, fmtMBps, fmtMbps, fmtBpp, fmtDur, fmtDuration
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AppCore = api;
})();
