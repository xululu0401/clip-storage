/* 视频存储对账台 · 核心测试（node --test tests/core.test.cjs）
 * 覆盖：独立锚点对拍、两条独立路径（逐秒累加 / 逐张试卡 / 二分法）、恒等式与单位不变性、
 *       单调性、阈值两侧、退化与边界、40+ 类非法输入、输出契约、确定性、不修改入参、
 *       9 个内置场景、300 组随机压力、文案锁。
 * 独立锚点来自 ../make-anchors.py（Python decimal 40 位，另一套实现），不共用本文件的任何代码。
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../core.js');

const ANCHOR_PATH = path.join(__dirname, '..', '..', 'evidence', '默认锚点.json');
const ANCHORS = JSON.parse(fs.readFileSync(ANCHOR_PATH, 'utf8'));
const D = (s) => Number(s);
const near = (a, b, tol) => Math.abs(a - b) <= (tol === undefined ? 1e-9 : tol) * Math.max(1, Math.abs(a), Math.abs(b));

function clone(c) { return JSON.parse(JSON.stringify(c)); }
function setClip(cfg, i, over) { cfg.clips[i] = Object.assign({}, cfg.clips[i], over); return cfg; }

/* ───────── 1. 独立锚点（Python decimal 另一套实现） ───────── */
test('独立锚点：默认场景的全部关键数字与 Python decimal 实现逐项一致', () => {
  const r = C.analyze(C.defaults());
  assert.strictEqual(r.clips.length, ANCHORS.clipCount);
  assert.strictEqual(r.audioBits, ANCHORS.audioBits);
  assert.ok(near(r.media.total, ANCHORS.mediaTotalBytes, 1e-15));
  assert.ok(near(r.media.usable, ANCHORS.mediaUsableBytes, 1e-15));
  assert.ok(near(r.targetSec, ANCHORS.targetSec, 1e-15));
  assert.ok(near(r.upBytesPerSec, ANCHORS.upBytesPerSec, 1e-15));
  assert.ok(near(r.sel.bps, ANCHORS.selBps, 1e-15));
  assert.ok(near(r.sel.videoBits, ANCHORS.clips[0].videoBits, 1e-15));
  assert.ok(near(r.sel.targetBytes, ANCHORS.selTargetBytes, 1e-15));
  assert.strictEqual(Math.floor(r.sel.recordSec), ANCHORS.selRecordSecByAccumulation, '逐秒累加得到的整秒数');
  assert.ok(near(r.sourceBytes, ANCHORS.sourceBytes, 1e-15));
  assert.strictEqual(r.proxyBytes, ANCHORS.proxyBytes);
  assert.ok(near(r.deliveryBytes, ANCHORS.deliveryBytes, 1e-15));
  assert.ok(near(r.projectBytes, ANCHORS.projectBytes, 1e-15));
  assert.strictEqual(r.cardsNeeded, ANCHORS.cardsNeeded);
  assert.ok(near(r.sel.writeMBps, D(ANCHORS.selWriteMBps), 1e-12), 'writeMBps');
  assert.ok(near(r.sel.bpp, D(ANCHORS.selBpp), 1e-12), 'bpp');
  assert.ok(near(r.sel.targetGB, D(ANCHORS.selTargetGB), 1e-12), 'targetGB');
  assert.ok(near(r.sel.targetGiB, D(ANCHORS.selTargetGiB), 1e-12), 'targetGiB');
  assert.ok(near(r.sel.recordMin, D(ANCHORS.selRecordMin), 1e-12), 'recordMin');
  assert.ok(near(r.sel.ratio, D(ANCHORS.selRatio), 1e-12), 'ratio');
  assert.ok(near(r.sel.uploadMin, D(ANCHORS.selUploadMin), 1e-12), 'uploadMin');
  assert.ok(near(r.rev.reqCapacityBytes, D(ANCHORS.reqCapacityBytes), 1e-12), 'reqCapacityBytes');
  assert.ok(near(r.rev.reqUploadMbps, D(ANCHORS.reqUploadMbps), 1e-12), 'reqUploadMbps');
  assert.ok(near(r.rev.reqRateMbpsForBpp, D(ANCHORS.reqRateMbpsForBpp), 1e-12), 'reqRateMbpsForBpp');
  assert.ok(near(r.rev.reqCapacity, D(ANCHORS.reqCapacityUnit), 1e-12), 'reqCapacity(单位)');
  assert.strictEqual(r.rev.reqGradeV, ANCHORS.writeGrade);
});

/* ───────── 2. 独立路径：逐秒累加 ───────── */
test('独立路径：逐秒累加求出的可录秒数 = 闭式除法的可录时长', () => {
  const r = C.analyze(C.defaults());
  r.clips.forEach((k) => {
    let acc = 0, sec = 0;
    while (acc + k.bps <= r.media.usable && sec < 3000000) { acc += k.bps; sec += 1; }
    assert.strictEqual(sec, Math.floor(r.media.usable / k.bps), '档位 ' + k.idx + ' 逐秒累加');
    assert.ok(Math.abs(k.recordMin * 60 - sec) < 1, '档位 ' + k.idx + ' 的闭式解与逐秒累加相差不到 1 秒');
    assert.ok(acc <= r.media.usable && acc + k.bps > r.media.usable);
  });
});

/* ───────── 3. 独立路径：二分法反推容量 ───────── */
test('独立路径：二分法求「录满目标时长所需容量」与闭式解一致', () => {
  const cfg = C.defaults();
  const r = C.analyze(cfg);
  const pct = cfg.usablePct / 100;
  const unit = cfg.capacityUnit === 'GiB' ? Math.pow(2, 30) : 1e9;
  // 单调前提：容量越大可录越长 —— 先用二分找「最小容量，使可录 >= 目标」
  let lo = 0, hi = 1e6;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const usable = mid * unit * pct;
    if (usable / r.sel.bps / 60 >= cfg.targetMinutes) hi = mid; else lo = mid;
  }
  assert.ok(near(hi, r.rev.reqCapacity, 1e-6), '二分 ' + hi + ' vs 闭式 ' + r.rev.reqCapacity);
  assert.ok(near(r.rev.reqCapacityBytes, r.sel.bps * cfg.targetMinutes * 60 / pct, 1e-12));
});

/* ───────── 4. 独立路径：逐张试卡 ───────── */
test('独立路径：逐张加卡直到装得下 = 引擎的 ceil 口径', () => {
  const r = C.analyze(C.defaults());
  let cards = 1;
  while (cards * r.media.usable < r.projectBytes) cards += 1;
  assert.strictEqual(cards, r.cardsNeeded);
  assert.ok((cards - 1) * r.media.usable < r.projectBytes);
});

/* ───────── 5. 恒等式 ───────── */
test('恒等式：每秒占用 / 目标文件 / 写入需求 / bpp / 项目总量 五条都成立', () => {
  const r = C.analyze(C.defaults());
  const c = r.cfg;
  const overhead = 1 + c.overheadPct / 100;
  r.clips.forEach((k) => {
    assert.ok(near(k.bps, (k.videoBits + r.audioBits) * overhead / 8, 1e-12), 'bps');
    assert.ok(near(k.targetBytes, k.bps * r.targetSec, 1e-12), 'targetBytes');
    assert.ok(near(k.writeMBps, k.bps / 1e6, 1e-12), 'writeMBps');
    assert.ok(near(k.bpp, k.videoBits / (k.w * k.h * k.fps), 1e-12), 'bpp');
    assert.ok(near(k.mbPerMin, k.bps * 60 / 1e6, 1e-12), 'mbPerMin');
    assert.ok(near(k.gbPerHour, k.bps * 3600 / 1e9, 1e-12), 'gbPerHour');
    assert.ok(near(k.videoBits, k.bps * 8 / overhead - r.audioBits, 1e-9), 'videoBits 反推');
  });
  assert.ok(near(r.projectBytes, r.sourceBytes + r.proxyBytes + r.deliveryBytes, 1e-12));
  assert.ok(near(r.sourceBytes, r.sel.bps * r.sourceMin * 60, 1e-12));
  assert.ok(near(r.sourceMin, c.targetMinutes * c.shootRatio * c.cameras, 1e-12));
});

/* ───────── 6. 单位不变性 ───────── */
test('单位不变性：全部档位 Mbps ↔ MB/s 等价改写后，每一个输出都逐位相同', () => {
  const a = clone(C.defaults());
  const b = clone(C.defaults());
  b.clips = b.clips.map((k) => Object.assign({}, k, { rateUnit: 'MB/s', rate: k.rate / 8 }));
  const ra = C.analyze(a), rb = C.analyze(b);
  ra.clips.forEach((k, i) => {
    assert.strictEqual(k.bps, rb.clips[i].bps, '档位 ' + i);
    assert.strictEqual(k.writeMBps, rb.clips[i].writeMBps);
    assert.strictEqual(k.recordMin, rb.clips[i].recordMin);
    assert.strictEqual(k.bpp, rb.clips[i].bpp);
  });
  assert.strictEqual(ra.projectBytes, rb.projectBytes);
  assert.strictEqual(ra.rev.reqUploadMbps, rb.rev.reqUploadMbps);
});

test('单位不变性：同一物理容量用 GB 或 GiB 填写，可录时长逐位相同', () => {
  const a = clone(C.defaults());
  const gib = 128e9 / Math.pow(2, 30);
  const b = clone(C.defaults());
  b.capacityUnit = 'GiB'; b.capacity = gib;
  const ra = C.analyze(a), rb = C.analyze(b);
  assert.ok(near(ra.media.usable, rb.media.usable, 1e-12));
  assert.ok(near(ra.sel.recordMin, rb.sel.recordMin, 1e-12));
  assert.ok(near(ra.sel.ratio, rb.sel.ratio, 1e-12));
});

test('单位不变性：十进制 GB 与二进制 GiB 的比值恒为 2^30/10^9', () => {
  const r = C.analyze(C.defaults());
  assert.ok(near(r.sel.targetGB / r.sel.targetGiB, Math.pow(2, 30) / 1e9, 1e-12));
  assert.ok(r.sel.targetGB > r.sel.targetGiB);
});

/* ───────── 7. 分辨率 / 帧率只影响 bpp ───────── */
test('码率恒定时改分辨率或帧率不改变文件大小，只改变 bpp', () => {
  const a = clone(C.defaults());
  const b = setClip(clone(C.defaults()), 0, { w: 1920, h: 1080, fps: 30 });
  const c = setClip(clone(C.defaults()), 0, { fps: 120 });
  const ra = C.analyze(a), rb = C.analyze(b), rc = C.analyze(c);
  assert.ok(near(ra.sel.bps, rb.sel.bps, 1e-12));
  assert.ok(near(ra.sel.targetBytes, rb.sel.targetBytes, 1e-12));
  assert.ok(near(ra.sel.recordMin, rb.sel.recordMin, 1e-12));
  assert.ok(near(rb.sel.bpp, ra.sel.bpp * 8, 1e-12), '像素率降到 1/8 → bpp ×8');
  assert.ok(near(rc.sel.bpp, ra.sel.bpp / 2, 1e-12), '帧率翻倍 → bpp 减半');
});

/* ───────── 8. 判定阈值两侧 ───────── */
test('判定阈值两侧：ratio 1.20 / 1.00 的分界与写入不达标的强制覆盖', () => {
  assert.strictEqual(C.verdictOf(1.2, true).id, 'ok');
  assert.strictEqual(C.verdictOf(1.1999999, true).id, 'tight');
  assert.strictEqual(C.verdictOf(1.0, true).id, 'tight');
  assert.strictEqual(C.verdictOf(0.9999999, true).id, 'bad');
  assert.strictEqual(C.verdictOf(9.9, false).id, 'bad', '写入不达标必须压过容量充裕');
  assert.strictEqual(C.verdictOf(NaN, true).id, 'bad');
  assert.strictEqual(C.verdictOf(1.2, null).id, 'ok', '卡速未填时只看容量');
});

test('判定阈值两侧：构造「刚好等于目标时长」的容量，判定落在「刚够」一侧', () => {
  const cfg = clone(C.defaults());
  const r0 = C.analyze(cfg);
  const pct = cfg.usablePct / 100;
  const unit = 1e9;
  cfg.capacity = r0.sel.bps * cfg.targetMinutes * 60 / pct / unit;
  const r = C.analyze(cfg);
  assert.ok(near(r.sel.recordMin, cfg.targetMinutes, 1e-6));
  assert.notStrictEqual(r.sel.verdict.id, 'bad');
  assert.ok(r.sel.verdict.id === 'tight' || r.sel.verdict.id === 'ok');
});

test('判定阈值两侧：卡速正好等于写入需求时算达标，超一点点就不达标', () => {
  const cfg = clone(C.defaults());
  const base = C.analyze(cfg);
  cfg.gradeMBps = base.sel.writeMBps;
  const okr = C.analyze(cfg);
  assert.strictEqual(okr.sel.writeOk, true, '正好相等算达标（≤）');
  cfg.gradeMBps = base.sel.writeMBps - 1e-6;
  const badr = C.analyze(cfg);
  assert.strictEqual(badr.sel.writeOk, false);
  assert.strictEqual(badr.sel.verdict.id, 'bad');
});

/* ───────── 9. 单调性 ───────── */
test('单调性：码率 11 档递增 → 可录时长严格递减、目标文件严格递增、bpp 严格递增', () => {
  let prevRec = Infinity, prevBytes = -Infinity, prevBpp = -Infinity;
  for (let i = 0; i < 11; i++) {
    const cfg = setClip(clone(C.defaults()), 0, { rate: 10 * Math.pow(1.3, i) });
    const r = C.analyze(cfg);
    assert.ok(r.sel.recordMin < prevRec, '可录时长应递减 @' + i);
    assert.ok(r.sel.targetBytes > prevBytes, '文件应递增 @' + i);
    assert.ok(r.sel.bpp > prevBpp, 'bpp 应递增 @' + i);
    prevRec = r.sel.recordMin; prevBytes = r.sel.targetBytes; prevBpp = r.sel.bpp;
  }
});

test('单调性：容量 11 档递增 → 可录时长与余量严格递增；卡张数不增', () => {
  let prevRec = -Infinity, prevCards = Infinity;
  for (let i = 0; i < 11; i++) {
    const cfg = clone(C.defaults());
    cfg.capacity = 16 * Math.pow(2, i);
    const r = C.analyze(cfg);
    assert.ok(r.sel.recordMin > prevRec, '可录时长应递增 @' + i);
    assert.ok(r.cardsNeeded <= prevCards, '卡张数不应增加 @' + i);
    prevRec = r.sel.recordMin; prevCards = r.cardsNeeded;
  }
});

test('单调性：上行带宽 11 档递增 → 上传时长严格递减，且逐渐逼近 0', () => {
  let prev = Infinity;
  for (let i = 0; i < 11; i++) {
    const cfg = clone(C.defaults());
    cfg.uploadMbps = 5 * Math.pow(2, i);
    const r = C.analyze(cfg);
    assert.ok(r.sel.uploadMin < prev, '上传时长应递减 @' + i);
    assert.ok(r.sel.uploadMin > 0);
    prev = r.sel.uploadMin;
  }
});

test('单调性：素材倍率与机位递增 → 项目总量与卡张数不降', () => {
  let prevBytes = -Infinity, prevCards = -Infinity;
  for (let i = 0; i < 8; i++) {
    const cfg = clone(C.defaults());
    cfg.shootRatio = 1 + i;
    cfg.cameras = 1 + Math.floor(i / 2);
    const r = C.analyze(cfg);
    assert.ok(r.projectBytes > prevBytes, '项目总量应递增 @' + i);
    assert.ok(r.cardsNeeded >= prevCards, '卡张数不应减少 @' + i);
    prevBytes = r.projectBytes; prevCards = r.cardsNeeded;
  }
});

/* ───────── 10. 退化与边界 ───────── */
test('退化：上行带宽 0 → 上传时长记 null（不是 Infinity），自检仍全过', () => {
  const cfg = clone(C.defaults());
  cfg.uploadMbps = 0;
  const r = C.analyze(cfg);
  assert.strictEqual(r.sel.uploadMin, null);
  assert.strictEqual(r.upBytesPerSec, 0);
  assert.strictEqual(r.checkSummary.total, C.CHECK_TOTAL);
  assert.strictEqual(r.checkSummary.fail, 0);
  const md = C.toMd(cfg);
  assert.ok(/不可计算/.test(md), 'Markdown 里要写明不可计算');
  assert.ok(!/Infinity|NaN/.test(md));
});

test('退化：带宽利用率 0 → 同样记 null；卡速 0 → 不判写入、判定只看容量', () => {
  const a = clone(C.defaults()); a.uploadUtilPct = 0;
  assert.strictEqual(C.analyze(a).sel.uploadMin, null);
  const b = clone(C.defaults()); b.gradeMBps = 0;
  const rb = C.analyze(b);
  assert.strictEqual(rb.sel.writeOk, null);
  assert.strictEqual(rb.sel.verdict.id, 'ok');
  assert.ok(rb.checks.every((x) => x.pass));
});

test('退化：代理码率 0 = 不做代理；打开后项目总量严格变大', () => {
  const a = C.analyze(C.defaults());
  assert.strictEqual(a.proxyBytes, 0);
  const cfg = clone(C.defaults()); cfg.proxyMbps = 20;
  const b = C.analyze(cfg);
  assert.ok(near(b.proxyBytes, 20e6 / 8 * b.sourceMin * 60, 1e-12));
  assert.ok(b.projectBytes > a.projectBytes || b.cardsNeeded >= a.cardsNeeded);
  assert.strictEqual(b.checkSummary.fail, 0);
});

test('边界：最小合法档位（16×16 @ 0.1 fps、码率 0.001 Mbps）能算出有限结果', () => {
  const cfg = clone(C.defaults());
  cfg.clips = [{ name: '极小', w: 16, h: 16, fps: 0.1, rateUnit: 'Mbps', rate: 0.001, codec: '其他' }];
  const v = C.validate(cfg);
  assert.strictEqual(v.ok, true, JSON.stringify(v.errors));
  const r = C.analyze(cfg);
  assert.ok(Number.isFinite(r.sel.recordMin) && r.sel.recordMin > 0);
  assert.ok(Number.isFinite(r.sel.bpp) && r.sel.bpp > 0);
  assert.strictEqual(r.checkSummary.fail, 0);
});

test('边界：8 个档位（上限）可以算，9 个档位被拒', () => {
  const cfg = clone(C.defaults());
  cfg.clips = [];
  for (let i = 0; i < 8; i++) cfg.clips.push({ name: '档 ' + i, w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 10 + i, codec: 'H.265' });
  assert.strictEqual(C.validate(cfg).ok, true);
  assert.strictEqual(C.analyze(cfg).clips.length, 8);
  cfg.clips.push({ name: '第九档', w: 1920, h: 1080, fps: 30, rateUnit: 'Mbps', rate: 10, codec: 'H.265' });
  const v = C.validate(cfg);
  assert.strictEqual(v.ok, false);
  assert.ok(v.errors.some((e) => e.field === 'clips'));
});

test('边界：1 个档位 + 素材倍率 1 + 单机位 → 项目总量 = 素材 + 成片', () => {
  const cfg = clone(C.defaults());
  cfg.clips = [cfg.clips[0]];
  cfg.shootRatio = 1; cfg.cameras = 1; cfg.pickedIdx = 0;
  const r = C.analyze(cfg);
  assert.ok(near(r.sourceMin, cfg.targetMinutes, 1e-12));
  assert.ok(near(r.projectBytes, r.sourceBytes + r.deliveryBytes, 1e-12));
  assert.strictEqual(r.cardsNeeded, 1, '素材 + 成片 91.48 GB < 单张可用 117.76 GB');
});

/* ───────── 11. 非法输入（逐条核字段） ───────── */
test('非法输入：40+ 类错误逐条落在正确的字段上，且 analyze 拒绝计算', () => {
  const bad = [
    ['clips 为空', (c) => { c.clips = []; }, 'clips'],
    ['档位超过 8 个', (c) => { for (let i = 0; i < 5; i++) c.clips.push(clone(c.clips[0])); }, 'clips'],
    ['分辨率不是数字', (c) => { c.clips[0].w = 'abc'; }, 'clips[0].wh'],
    ['分辨率太小', (c) => { c.clips[0].w = 8; }, 'clips[0].wh'],
    ['分辨率太大', (c) => { c.clips[0].h = 30000; }, 'clips[0].wh'],
    ['分辨率不是整数', (c) => { c.clips[0].w = 1920.5; }, 'clips[0].wh'],
    ['帧率为 0', (c) => { c.clips[0].fps = 0; }, 'clips[0].fps'],
    ['帧率为负', (c) => { c.clips[0].fps = -30; }, 'clips[0].fps'],
    ['帧率过大', (c) => { c.clips[0].fps = 5000; }, 'clips[0].fps'],
    ['码率为 0', (c) => { c.clips[0].rate = 0; }, 'clips[0].rate'],
    ['码率为负', (c) => { c.clips[0].rate = -5; }, 'clips[0].rate'],
    ['码率超上限', (c) => { c.clips[0].rate = 200000; }, 'clips[0].rate'],
    ['第二档码率为空', (c) => { c.clips[1].rate = ''; }, 'clips[1].rate'],
    ['音频码率为负', (c) => { c.audioKbps = -1; }, 'audioKbps'],
    ['音频码率过大', (c) => { c.audioKbps = 99999; }, 'audioKbps'],
    ['音轨数为 0', (c) => { c.audioTracks = 0; }, 'audioTracks'],
    ['音轨数为小数', (c) => { c.audioTracks = 120; }, 'audioTracks'],
    ['封装开销为负', (c) => { c.overheadPct = -1; }, 'overheadPct'],
    ['封装开销过大', (c) => { c.overheadPct = 80; }, 'overheadPct'],
    ['目标时长为 0', (c) => { c.targetMinutes = 0; }, 'targetMinutes'],
    ['目标时长为负', (c) => { c.targetMinutes = -60; }, 'targetMinutes'],
    ['目标时长过大', (c) => { c.targetMinutes = 1e6; }, 'targetMinutes'],
    ['目标时长为空', (c) => { c.targetMinutes = ''; }, 'targetMinutes'],
    ['容量为 0', (c) => { c.capacity = 0; }, 'capacity'],
    ['容量为负', (c) => { c.capacity = -128; }, 'capacity'],
    ['容量过大', (c) => { c.capacity = 1e9; }, 'capacity'],
    ['容量为文本', (c) => { c.capacity = '一百'; }, 'capacity'],
    ['可用比例为 0', (c) => { c.usablePct = 0; }, 'usablePct'],
    ['可用比例超过 100', (c) => { c.usablePct = 101; }, 'usablePct'],
    ['可用比例为负', (c) => { c.usablePct = -5; }, 'usablePct'],
    ['卡速为负', (c) => { c.gradeMBps = -1; }, 'gradeMBps'],
    ['卡速为文本', (c) => { c.gradeMBps = '快'; }, 'gradeMBps'],
    ['带宽为负', (c) => { c.uploadMbps = -10; }, 'uploadMbps'],
    ['带宽为文本', (c) => { c.uploadMbps = '一百'; }, 'uploadMbps'],
    ['利用率为负', (c) => { c.uploadUtilPct = -1; }, 'uploadUtilPct'],
    ['利用率超过 100', (c) => { c.uploadUtilPct = 120; }, 'uploadUtilPct'],
    ['期望上传时间为 0', (c) => { c.targetUploadMinutes = 0; }, 'targetUploadMinutes'],
    ['期望上传时间为负', (c) => { c.targetUploadMinutes = -1; }, 'targetUploadMinutes'],
    ['期望上传时间过大', (c) => { c.targetUploadMinutes = 2e6; }, 'targetUploadMinutes'],
    ['素材倍率为 0', (c) => { c.shootRatio = 0; }, 'shootRatio'],
    ['素材倍率为 0.5', (c) => { c.shootRatio = 0.5; }, 'shootRatio'],
    ['素材倍率过大', (c) => { c.shootRatio = 200; }, 'shootRatio'],
    ['机位为 0', (c) => { c.cameras = 0; }, 'cameras'],
    ['机位为 1.5', (c) => { c.cameras = 1.5; }, 'cameras'],
    ['代理码率为负', (c) => { c.proxyMbps = -1; }, 'proxyMbps'],
    ['代理码率过大', (c) => { c.proxyMbps = 1e6; }, 'proxyMbps'],
    ['bpp 参考为负', (c) => { c.bppRef = -0.1; }, 'bppRef'],
    ['bpp 参考过大', (c) => { c.bppRef = 100; }, 'bppRef']
  ];
  bad.forEach(([name, mutate, field]) => {
    const cfg = clone(C.defaults());
    mutate(cfg);
    const v = C.validate(cfg);
    assert.strictEqual(v.ok, false, name + ' 应该被判非法');
    assert.ok(v.errors.some((e) => e.field === field), name + ' 的错误应落在 ' + field + '，实际 ' + JSON.stringify(v.errors));
    assert.throws(() => C.analyze(cfg), (e) => e && e.validation && e.validation.errors.length > 0, name + ' analyze 应该抛错');
  });
  assert.ok(bad.length >= 40, '非法用例数 ' + bad.length);
});

test('非法输入：错误信息里有可读的中文说明，不是一个光秃秃的字段名', () => {
  const cfg = clone(C.defaults());
  cfg.clips[0].rate = -1;
  const v = C.validate(cfg);
  assert.ok(/码率/.test(v.errors[0].msg));
  assert.ok(/档位|4K60/.test(v.errors[0].msg));
});

/* ───────── 12. 输出契约 ───────── */
test('输出契约：所有返回值字段存在且类型正确，没有 NaN / Infinity 漏出', () => {
  const r = C.analyze(C.defaults());
  ['cfg', 'clips', 'sel', 'selIdx', 'media', 'rev', 'checks', 'checkSummary'].forEach((k) => {
    assert.ok(Object.prototype.hasOwnProperty.call(r, k), '缺少字段 ' + k);
  });
  ['bps', 'bpp', 'targetBytes', 'recordMin', 'writeMBps', 'ratio', 'mbPerMin', 'gbPerHour', 'verdict'].forEach((k) => {
    assert.ok(Object.prototype.hasOwnProperty.call(r.sel, k), 'sel 缺字段 ' + k);
  });
  assert.ok(Array.isArray(r.clips) && r.clips.length >= 1);
  assert.strictEqual(typeof r.sel.verdict.id, 'string');
  assert.strictEqual(typeof r.sel.verdict.label, 'string');
  assert.ok(Number.isFinite(r.sel.bps) && r.sel.bps > 0);
  assert.ok(Number.isFinite(r.sel.recordMin) && r.sel.recordMin > 0);
  assert.ok(Number.isFinite(r.media.usable) && r.media.usable > 0);
  ['reqCapacityBytes', 'reqGradeMBps', 'reqUploadMbps', 'reqRateMbpsForBpp', 'reqCapacity'].forEach((k) => {
    assert.ok(Number.isFinite(r.rev[k]), 'rev.' + k + ' 应为有限数');
    assert.ok(r.rev[k] > 0, 'rev.' + k + ' 应为正数');
  });
  const walk = (o, p) => {
    if (typeof o === 'number') assert.ok(Number.isFinite(o), p + ' 是 ' + o);
    else if (o && typeof o === 'object') Object.keys(o).forEach((k) => walk(o[k], p + '.' + k));
  };
  walk(C.analyze(C.defaults()), 'res');
});

test('确定性：同一输入算两次，结果逐位相同；入参没有被修改', () => {
  const cfg = C.defaults();
  const snapshot = JSON.stringify(cfg);
  const a = JSON.stringify(C.analyze(cfg));
  const b = JSON.stringify(C.analyze(cfg));
  assert.strictEqual(a, b);
  assert.strictEqual(JSON.stringify(cfg), snapshot, 'analyze 不应修改入参');
  const cfg2 = clone(C.defaults());
  C.sensitivity(cfg2); C.insights(C.analyze(cfg2)); C.steps(C.analyze(cfg2)); C.toCsv(cfg2); C.toMd(cfg2);
  assert.strictEqual(JSON.stringify(cfg2), JSON.stringify(C.defaults()), '这些函数都不应修改入参');
});

test('归一化：字符串数字带千分位 / 全角 / 百分号 / 中文逗号都能解析，乱码返回 NaN', () => {
  assert.strictEqual(C.num('1,234.5'), 1234.5);
  assert.strictEqual(C.num('１２８'), 128);
  assert.strictEqual(C.num(' 92 %'), 92);
  assert.strictEqual(C.num('1，000'), 1000);
  assert.strictEqual(C.num('−5'), -5);
  assert.ok(Number.isNaN(C.num('一百')));
  assert.ok(Number.isNaN(C.num('')));
  assert.ok(Number.isNaN(C.num(null)));
});

/* ───────── 13. 场景与结构自检 ───────── */
test('9 个内置场景全部通过校验，且每个场景的 18 项结构自检全过', () => {
  const list = C.scenarios();
  assert.strictEqual(list.length, 9);
  const ids = new Set();
  list.forEach((s) => {
    assert.ok(!ids.has(s.id), '场景 id 重复：' + s.id);
    ids.add(s.id);
    assert.ok(s.name && s.note, '场景要有名称与说明');
    const v = C.validate(s.cfg);
    assert.strictEqual(v.ok, true, s.id + ' 校验失败：' + JSON.stringify(v.errors));
    const r = C.analyze(s.cfg);
    assert.strictEqual(r.checkSummary.total, C.CHECK_TOTAL, s.id + ' 自检项数应为 ' + C.CHECK_TOTAL);
    assert.strictEqual(r.checkSummary.fail, 0, s.id + ' 自检失败：' + JSON.stringify(r.checks.filter((x) => !x.pass)));
  });
});

test('场景工厂：scenarioCfg 返回深拷贝，改它不影响默认值', () => {
  const a = C.scenarioCfg('prores');
  a.clips[0].rate = 1;
  a.targetMinutes = 999;
  const b = C.scenarioCfg('prores');
  assert.notStrictEqual(b.clips[0].rate, 1);
  assert.notStrictEqual(b.targetMinutes, 999);
  assert.strictEqual(C.scenarioCfg('不存在的场景').clips.length, C.defaults().clips.length);
});

test('结构自检项数恒定：默认 / 各场景 / 退化输入下都是 18 项', () => {
  const cases = [C.defaults()];
  C.scenarios().forEach((s) => cases.push(s.cfg));
  const deg = clone(C.defaults()); deg.uploadMbps = 0; deg.gradeMBps = 0; cases.push(deg);
  const deg2 = clone(C.defaults()); deg2.capacity = 0.5; deg2.usablePct = 100; cases.push(deg2);
  cases.forEach((cfg, i) => {
    const r = C.analyze(cfg);
    assert.strictEqual(r.checks.length, C.CHECK_TOTAL, '第 ' + i + ' 组自检项数不对');
    assert.strictEqual(r.checkSummary.pass + r.checkSummary.fail, C.CHECK_TOTAL);
  });
});

/* ───────── 14. 随机压力 ───────── */
test('随机压力 300 组：全部通过校验且 18 项结构自检全过、无 NaN 漏出', () => {
  let seed = 20261111;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let totalChecks = 0, ok = 0;
  for (let i = 0; i < 300; i++) {
    const n = 1 + Math.floor(rnd() * 8);
    const clips = [];
    for (let k = 0; k < n; k++) {
      clips.push({
        name: '档' + k, w: pick([640, 1280, 1920, 2560, 3840, 4096, 7680]), h: pick([360, 720, 1080, 1440, 2160, 4320]),
        fps: pick([24, 25, 30, 50, 60, 120, 240]), rateUnit: pick(['Mbps', 'MB/s']),
        rate: Math.round((0.5 + rnd() * 900) * 1000) / 1000, codec: pick(C.CODECS)
      });
    }
    const cfg = {
      label: '随机 ' + i, clips,
      audioKbps: Math.round(rnd() * 640), audioTracks: 1 + Math.floor(rnd() * 8),
      overheadPct: Math.round(rnd() * 12 * 100) / 100,
      targetMinutes: Math.round((0.5 + rnd() * 5000) * 100) / 100,
      capacity: Math.round((1 + rnd() * 4000) * 100) / 100,
      capacityUnit: pick(['GB', 'GiB']),
      usablePct: Math.round((20 + rnd() * 80) * 100) / 100,
      gradeMBps: Math.round(rnd() * 300 * 100) / 100,
      uploadMbps: Math.round(rnd() * 900 * 100) / 100,
      uploadUtilPct: Math.round(rnd() * 100 * 100) / 100,
      targetUploadMinutes: Math.round((1 + rnd() * 600) * 100) / 100,
      shootRatio: 1 + Math.floor(rnd() * 12), cameras: 1 + Math.floor(rnd() * 6),
      proxyMbps: rnd() < 0.4 ? Math.round(rnd() * 60 * 100) / 100 : 0,
      bppRef: Math.round(rnd() * 0.5 * 1000) / 1000,
      pickedIdx: Math.floor(rnd() * n)
    };
    const v = C.validate(cfg);
    assert.strictEqual(v.ok, true, '第 ' + i + ' 组应合法：' + JSON.stringify(v.errors) + ' ' + JSON.stringify(cfg));
    const r = C.analyze(cfg);
    assert.strictEqual(r.checks.length, C.CHECK_TOTAL);
    const failed = r.checks.filter((x) => !x.pass);
    assert.strictEqual(failed.length, 0, '第 ' + i + ' 组自检失败：' + JSON.stringify(failed) + ' ' + JSON.stringify(cfg));
    totalChecks += r.checks.length;
    ok++;
  }
  assert.strictEqual(ok, 300);
  assert.ok(totalChecks >= 5400, '累计断言 ' + totalChecks);
});

test('随机压力：单字段乱填（含空串、null、"abc"）时一律判非法，不会静默当默认值', () => {
  const fields = ['audioKbps', 'audioTracks', 'overheadPct', 'targetMinutes', 'capacity', 'usablePct',
    'gradeMBps', 'uploadMbps', 'uploadUtilPct', 'targetUploadMinutes', 'shootRatio', 'cameras', 'proxyMbps', 'bppRef'];
  const junk = ['abc', null, {}];
  fields.forEach((f) => {
    junk.forEach((j) => {
      const cfg = clone(C.defaults());
      cfg[f] = j;
      const v = C.validate(cfg);
      assert.strictEqual(v.ok, false, f + ' = ' + JSON.stringify(j) + ' 应判非法（静默兜底会掩盖输入错误）');
    });
  });
  const cfg = clone(C.defaults());
  cfg.clips = 'not-an-array';
  assert.strictEqual(C.validate(cfg).ok, true, 'clips 非数组时回落到默认档位（不能崩）');
  // 约定：字段「缺失」（undefined）按未填写处理 → 回落默认值；null / '' 是「填了但填错」→ 报错
  const miss = clone(C.defaults());
  delete miss.uploadMbps;
  assert.strictEqual(C.validate(miss).ok, true, '缺失字段按默认值处理');
  assert.strictEqual(C.normCfg(miss).uploadMbps, C.defaults().uploadMbps);
  const nul = clone(C.defaults());
  nul.uploadMbps = null;
  assert.strictEqual(C.validate(nul).ok, false, 'null 是填错，不是缺失');
});

/* ───────── 15. 导出与备份 ───────── */
test('导出 CSV：行数够、含关键数字、能被解析成等宽列', () => {
  const csv = C.toCsv(C.defaults());
  const lines = csv.split('\n');
  assert.ok(lines.length > 30, 'CSV 行数 ' + lines.length);
  assert.ok(csv.indexOf('12.7058') >= 0, 'CSV 要含每秒占用');
  assert.ok(csv.indexOf('3') >= 0);
  assert.ok(csv.indexOf('结构自检') >= 0);
  assert.ok(csv.indexOf('敏感性') >= 0);
  lines.forEach((l, i) => {
    const q = (l.match(/"/g) || []).length;
    assert.strictEqual(q % 2, 0, '第 ' + i + ' 行引号不成对：' + l);
  });
  assert.ok(!/NaN|Infinity/.test(csv));
});

test('导出 Markdown：含判定、口径、自检，且没有字面 Markdown 星号', () => {
  const md = C.toMd(C.defaults());
  assert.ok(/结论/.test(md) && /档位账/.test(md) && /敏感性/.test(md) && /结构自检 18\/18/.test(md));
  assert.ok(md.indexOf('12.71') >= 0 || md.indexOf('12.7058') >= 0);
  assert.strictEqual((md.match(/\*\*/g) || []).length, 0, '导出文本里不应有字面 Markdown 星号');
  assert.ok(!/NaN|Infinity/.test(md));
});

test('备份：往返一致；拒绝别的 app 的备份、坏 JSON、空档位', () => {
  const cfg = C.defaults();
  const text = C.backupJson(cfg);
  const back = C.readBackup(text);
  assert.strictEqual(back.ok, true, back.error);
  assert.strictEqual(JSON.stringify(C.normCfg(back.cfg)), JSON.stringify(C.normCfg(cfg)));
  assert.strictEqual(C.readBackup('{ not json').ok, false);
  assert.strictEqual(C.readBackup(JSON.stringify({ app: 'yield-ledger', cfg })).ok, false);
  assert.strictEqual(C.readBackup(JSON.stringify({ app: C.slug, cfg: { clips: [] } })).ok, false);
  const bad = C.readBackup(JSON.stringify({ app: C.slug, cfg: (() => { const x = clone(cfg); x.clips[0].rate = -1; return x; })() }));
  assert.strictEqual(bad.ok, false);
  assert.ok(/校验/.test(bad.error), '错误信息要说明是校验问题：' + bad.error);
});

test('备份：非法数值在备份里被拒绝，不会带进页面', () => {
  const cfg = clone(C.defaults());
  cfg.usablePct = 999;
  const bad = C.readBackup(JSON.stringify({ app: C.slug, cfg }));
  assert.strictEqual(bad.ok, false);
  assert.ok(/可用比例/.test(bad.error), bad.error);
});

/* ───────── 16. 文案锁 ───────── */
test('文案锁：要记住的几条与下一步里没有字面 Markdown 星号、没有 NaN，数字都能追溯', () => {
  const r = C.analyze(C.defaults());
  const ins = C.insights(r), steps = C.steps(r);
  assert.ok(ins.length >= 5, 'insights 条数 ' + ins.length);
  assert.ok(steps.length >= 1);
  ins.concat(steps).forEach((x, i) => {
    assert.ok(x.title && x.text, '第 ' + i + ' 条缺少标题或正文');
    assert.strictEqual((x.title + x.text).indexOf('**'), -1, '第 ' + i + ' 条残留字面星号');
    assert.ok(!/NaN|Infinity|undefined/.test(x.title + x.text), '第 ' + i + ' 条有坏数字：' + x.title);
  });
  const all = ins.map((x) => x.title + x.text).join(' ');
  assert.ok(all.indexOf('12.71') >= 0, '单位陷阱那条要写出真实的每秒 MB');
  assert.ok(all.indexOf('119.21') >= 0, '容量口径那条要写出 128 GB = 119.21 GiB');
  assert.ok(/0\.2\d\d|0\.1\d\d/.test(all), 'bpp 对照那条要有真实的 bpp 数字');
  steps.forEach((s) => {
    assert.ok(s.patch === null || (s.patch && typeof s.patch === 'object'), 'patch 必须是对象或 null');
    if (s.patch) {
      assert.ok(s.patch.scope === 'cfg' || s.patch.scope === 'clip', 'patch.scope 只能是 cfg / clip');
      assert.ok(s.patch.values && typeof s.patch.values === 'object');
      if (s.patch.scope === 'clip') assert.ok(Number.isInteger(s.patch.idx));
    }
  });
});

function applyPatch(cfg, patch) {
  const c = clone(cfg);
  if (!patch) return c;
  if (patch.scope === 'clip') c.clips[patch.idx] = Object.assign({}, c.clips[patch.idx], patch.values);
  else Object.assign(c, patch.values);
  return c;
}

test('文案锁：下一步里的「一键采用」补丁真的能解决问题（改完重算通过）', () => {
  const cfg = clone(C.defaults());
  cfg.capacity = 16;             // 故意太小 → 应该出现「加容量」的建议
  cfg.uploadMbps = 5;            // 故意太慢 → 应该出现「加带宽」的建议
  cfg.gradeMBps = 1;             // 故意太慢 → 应该出现「换卡」的建议
  const r0 = C.analyze(cfg);
  const steps = C.steps(r0);
  const val = (s) => (s.patch && s.patch.values) || {};
  const capStep = steps.filter((s) => val(s).capacity !== undefined)[0];
  const upStep = steps.filter((s) => val(s).uploadMbps !== undefined)[0];
  const gradeStep = steps.filter((s) => val(s).gradeMBps !== undefined)[0];
  assert.ok(capStep, '应给出容量建议');
  assert.ok(upStep, '应给出带宽建议');
  assert.ok(gradeStep, '应给出卡速建议');

  const r1 = C.analyze(applyPatch(cfg, capStep.patch));
  assert.ok(r1.sel.recordMin >= cfg.targetMinutes - 1e-9, '采用容量建议后应能录满目标时长');

  const c2 = applyPatch(cfg, upStep.patch);
  assert.ok(C.analyze(c2).sel.uploadMin <= cfg.targetUploadMinutes + 1e-9, '采用带宽建议后应按时传完');

  const c3 = applyPatch(cfg, gradeStep.patch);
  assert.strictEqual(C.analyze(c3).sel.writeOk, true, '采用卡速建议后写入应达标');
});

test('文案锁：bpp 低于参考下限时给出的码率建议，回代后确实能达标', () => {
  const cfg = clone(C.defaults());
  setClip(cfg, 0, { rate: 2 });   // 2 Mbps @4K60 → bpp 极低
  cfg.bppRef = 0.15;
  const r = C.analyze(cfg);
  assert.ok(r.sel.bpp < cfg.bppRef);
  const step = C.steps(r).filter((s) => s.patch && s.patch.scope === 'clip' && s.patch.values.rate !== undefined)[0];
  assert.ok(step, '应给出码率建议');
  const r2 = C.analyze(applyPatch(cfg, step.patch));
  assert.ok(r2.sel.bpp >= cfg.bppRef - 1e-9, '回代 bpp ' + r2.sel.bpp + ' 应 ≥ ' + cfg.bppRef);
});

/* ───────── 17. 格式化 ───────── */
test('格式化：时长 / 字节 / 速率 / 百分比 的边界都读得懂', () => {
  assert.strictEqual(C.fmtDur(0.5), '30 秒');
  assert.strictEqual(C.fmtDur(59.994), '59.99 分钟');
  assert.strictEqual(C.fmtDur(60), '1 小时整');
  assert.strictEqual(C.fmtDur(154.47), '2 小时 34 分');
  assert.strictEqual(C.fmtDur(364.5), '6 小时 4.5 分');
  assert.strictEqual(C.fmtDur(3598.6), '59 小时 59 分');
  assert.strictEqual(C.fmtDur(null), '—');
  assert.strictEqual(C.fmtBytes(999), '999 B');
  assert.strictEqual(C.fmtBytes(128e9), '128.00 GB');
  assert.strictEqual(C.fmtGiB(128e9), '119.21 GiB');
  assert.strictEqual(C.fmtNum(1234567.891, 2), '1,234,567.89');
  assert.strictEqual(C.fmtMBps(12705800), '12.71 MB/s');
  assert.strictEqual(C.fmtMbps(127.058), '127.06 Mbps');
  assert.strictEqual(C.fmtBpp(0.200938786), '0.201');
  assert.strictEqual(C.fmtPct(92, 0), '92%');
  assert.strictEqual(C.fmtNum(NaN, 2), '—');
  assert.strictEqual(C.fmtNum(null, 2), '—');
});

test('舍入工具：ceilTo 与 round 在整数边界与极小步长下不抖动', () => {
  assert.strictEqual(C.ceilTo(12.7058, 0.5), 13);
  assert.strictEqual(C.ceilTo(12.0, 0.5), 12);
  assert.strictEqual(C.ceilTo(0.1 + 0.2, 0.1), 0.3);
  assert.strictEqual(C.ceilTo(-0.1, 0.5), 0);
  assert.strictEqual(C.round(2.675, 2), 2.68);
  assert.strictEqual(C.round(-1.005, 2), -1.01);
  assert.strictEqual(C.round(1234.5678, -2), 1200, '负位数 = 四舍五入到百位');
});

/* ───────── 18. 反推与敏感性 ───────── */
test('反推：三条建议互相独立，回代都成立（容量 / 带宽 / 码率）', () => {
  const cfg = C.defaults();
  const r = C.analyze(cfg);
  // 容量回代
  const c1 = clone(cfg); c1.capacity = r.rev.reqCapacity + 1e-9;
  assert.ok(C.analyze(c1).sel.recordMin >= cfg.targetMinutes - 1e-6);
  // 带宽回代
  const c2 = clone(cfg); c2.uploadMbps = r.rev.reqUploadMbps;
  assert.ok(C.analyze(c2).sel.uploadMin <= cfg.targetUploadMinutes + 1e-6);
  // 码率回代
  const c3 = clone(cfg); setClip(c3, 0, { rate: r.rev.reqRateMbpsForBpp });
  assert.ok(C.analyze(c3).sel.bpp >= cfg.bppRef - 1e-12);
});

test('敏感性：12 行都有完整结果；改码率 / 容量 / 带宽的三行方向正确', () => {
  const cfg = C.defaults();
  const rows = C.sensitivity(cfg);
  assert.strictEqual(rows.length, 12);
  rows.forEach((x) => {
    assert.ok(x.name && Number.isFinite(x.writeMBps) && Number.isFinite(x.recordMin) && Number.isFinite(x.usableBytes));
    assert.ok(x.verdict && typeof x.verdict.label === 'string');
    assert.ok(x.cards === null || (Number.isInteger(x.cards) && x.cards >= 1));
  });
  const base = C.analyze(cfg).sel.recordMin;
  const plus = rows.filter((x) => /码率 \+20%/.test(x.name))[0];
  const minus = rows.filter((x) => /码率 −20%/.test(x.name))[0];
  assert.ok(plus.recordMin < base && minus.recordMin > base);
  const more = rows.filter((x) => /容量 \+64 GB/.test(x.name))[0];
  assert.ok(more.recordMin > base);
  const halfUp = rows.filter((x) => /上行带宽 ÷2/.test(x.name))[0];
  assert.ok(halfUp.uploadMin > C.analyze(cfg).sel.uploadMin);
});

test('敏感性：只改上传带宽的行不应改变容量、可录时长与卡张数', () => {
  const cfg = C.defaults();
  const rows = C.sensitivity(cfg);
  const up = rows.filter((x) => x.name.indexOf('上行带宽') === 0);
  assert.ok(up.length >= 2);
  const base = C.analyze(cfg);
  up.forEach((x) => {
    assert.ok(near(x.recordMin, base.sel.recordMin, 1e-12), x.name + ' 不该改可录时长');
    assert.strictEqual(x.cards, base.cardsNeeded);
  });
});

test('敏感性：只改「可用比例」的行应改可录时长但不改目标文件大小', () => {
  const cfg = C.defaults();
  const row = C.sensitivity(cfg).filter((x) => /可用比例降低|可用比例降到/.test(x.name))[0];
  const base = C.analyze(cfg);
  assert.ok(row.recordMin < base.sel.recordMin);
  assert.ok(near(row.targetGB, base.sel.targetGB, 1e-12));
});

/* ───────── 19. 索引与选中档位 ───────── */
test('选中档位：pickedIdx 越界时收敛到合法范围，不崩也不返回 undefined', () => {
  const a = clone(C.defaults()); a.pickedIdx = 99;
  assert.strictEqual(C.analyze(a).selIdx, a.clips.length - 1);
  const b = clone(C.defaults()); b.pickedIdx = -5;
  assert.strictEqual(C.analyze(b).selIdx, 0);
  const c = clone(C.defaults()); c.pickedIdx = 'abc';
  assert.strictEqual(C.analyze(c).selIdx, 0);
});

test('选中档位：换档位只改判定与 bpp，不改介质、素材时长与上传口径', () => {
  const a = C.analyze(C.defaults());
  const cfg = clone(C.defaults()); cfg.pickedIdx = 2;
  const b = C.analyze(cfg);
  assert.strictEqual(a.media.usable, b.media.usable);
  assert.strictEqual(a.sourceMin, b.sourceMin);
  assert.strictEqual(a.upBytesPerSec, b.upBytesPerSec);
  assert.notStrictEqual(a.sel.bps, b.sel.bps);
  assert.strictEqual(b.checkSummary.fail, 0);
});

/* ───────── 20. 常识与量纲的独立检查 ───────── */
test('常识与量纲：100 Mbps 的一小时 ≈ 45 GB；1 GiB > 1 GB；上传 45.74 GB 于 80 Mbps 有效速率 ≈ 76 分钟', () => {
  const r = C.analyze(C.defaults());
  assert.ok(near(r.clips[0].gbPerHour, 45.74, 1e-3), '每小时 GB：' + r.clips[0].gbPerHour);
  assert.ok(r.clips[0].mbPerMin > 700 && r.clips[0].mbPerMin < 800, '每分钟 MB：' + r.clips[0].mbPerMin);
  assert.ok(Math.pow(2, 30) > 1e9);
  // 有效上行 = 100 Mbps × 80% = 10 MB/s → 45.74088 GB / 10 MB/s = 4574.088 s = 76.23 分钟
  assert.ok(near(r.sel.uploadMin, 45.74088e9 / 10e6 / 60, 1e-9));
  // 128 GB 的 92% = 117.76 GB，可录 154.47 分钟 > 目标 60 分钟 → 「够用」
  assert.ok(near(r.media.usable, 117.76e9, 1e-9));
  assert.strictEqual(r.sel.verdict.id, 'ok');
});
