import type { Subtitle } from './types';

/**
 * 镜头切点检查：按可调采样间隔抽帧，逐帧缩放到固定尺寸后计算相邻帧
 * RGB 直方图差；差值超过阈值的候选点在最小间隔内只保留差值最大者
 * （贪心非极大值抑制）。再找出跨越切点或字幕边界距切点小于容差的
 * 冲突字幕。纯分析功能：不修改任何字幕，也不触碰撤销历史。
 */

/** 抽帧统一缩放到的固定尺寸（忽略原始宽高比） */
export const SHOT_FRAME_W = 64;
export const SHOT_FRAME_H = 48;
/** 每通道 8 个箱（每箱 32 个色阶），三通道共 24 箱 */
const HIST_BINS = 8 * 3;

export interface ShotParams {
  /** 采样间隔（毫秒）：每隔多久抽一帧 */
  sampleMs: number;
  /** RGB 直方图差阈值（严格 0–1）：严格超过才成为候选切点 */
  threshold: number;
  /** 最小切点间隔（毫秒）：此间隔内的候选只保留差值最大者 */
  minGapMs: number;
  /** 字幕边界容差（毫秒）：起 / 止边界距切点小于此值视为冲突 */
  toleranceMs: number;
}

export interface ShotCut {
  /** 切点时间（毫秒），取相邻两帧中后一帧的采样时间 */
  time: number;
  /** RGB 直方图差，归一化到 0–1 */
  diff: number;
}

/** span：切点落在字幕区间内；start / end：切点贴近字幕始 / 末边界 */
export type ShotConflictType = 'span' | 'start' | 'end';

export interface ShotConflict {
  /** 切点时间（毫秒） */
  cutTime: number;
  /** 该切点的直方图差 */
  diff: number;
  /** 冲突类型 */
  type: ShotConflictType;
  subtitleId: string;
  index: number;
  /** 字幕原起止（毫秒） */
  start: number;
  end: number;
  text: string;
  /** 切点相对边界的毫秒差（切点 − 边界）；仅边界冲突有效 */
  distanceMs: number;
}

export type ParsedShotParams =
  | { ok: true; params: ShotParams }
  | { ok: false; error: string };

/** 解析侧栏参数文本 */
export function parseShotParams(raw: {
  sampleMs: string;
  threshold: string;
  minGapMs: string;
  toleranceMs: string;
}): ParsedShotParams {
  const sampleMs = Number(raw.sampleMs);
  const threshold = Number(raw.threshold);
  const minGapMs = Number(raw.minGapMs);
  const toleranceMs = Number(raw.toleranceMs);
  if (!Number.isFinite(sampleMs) || sampleMs <= 0)
    return { ok: false, error: '采样间隔须为大于 0 的毫秒数（建议 200–1000）' };
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold >= 1)
    return { ok: false, error: '差值阈值须为 0 到 1 之间的数值（建议 0.2–0.5）' };
  if (!Number.isFinite(minGapMs) || minGapMs < 0)
    return { ok: false, error: '最小切点间隔须为不小于 0 的毫秒数' };
  if (!Number.isFinite(toleranceMs) || toleranceMs < 0)
    return { ok: false, error: '边界容差须为不小于 0 的毫秒数' };
  return { ok: true, params: { sampleMs, threshold, minGapMs, toleranceMs } };
}

/**
 * 从已缩放到固定尺寸的画布上统计 RGB 直方图：
 * 每通道 8 箱（色阶右移 5 位），返回长度 24 的计数数组。
 */
export function extractHistogram(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): Uint32Array {
  const { data } = ctx.getImageData(0, 0, width, height);
  const hist = new Uint32Array(HIST_BINS);
  for (let i = 0; i < data.length; i += 4) {
    hist[data[i] >> 5]++;
    hist[8 + (data[i + 1] >> 5)]++;
    hist[16 + (data[i + 2] >> 5)]++;
  }
  return hist;
}

/**
 * 两个 RGB 直方图的归一化差值：各箱计数差绝对值之和除以 6 × 像素数
 * （每个直方图 R/G/B 三通道的计数总和均为 3 × 像素数，两分布完全不相交时
 * 差值之和为 6 × 像素数），结果范围 0–1。
 */
export function histogramDistance(a: Uint32Array, b: Uint32Array): number {
  let sum = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) sum += Math.abs(a[i] - b[i]);
  return sum / (6 * SHOT_FRAME_W * SHOT_FRAME_H);
}

/**
 * 候选切点非极大值抑制：按差值从大到小贪心选取（同差值取时间较早者），
 * 与任一已保留切点的时间距离严格小于最小间隔的候选被丢弃；
 * 结果按时间升序返回。
 */
export function suppressCuts(
  candidates: ReadonlyArray<ShotCut>,
  minGapMs: number
): ShotCut[] {
  const order = [...candidates].sort((a, b) => b.diff - a.diff || a.time - b.time);
  const kept: ShotCut[] = [];
  for (const c of order) {
    let dominated = false;
    for (const k of kept) {
      if (Math.abs(c.time - k.time) < minGapMs) {
        dominated = true;
        break;
      }
    }
    if (!dominated) kept.push({ time: c.time, diff: c.diff });
  }
  return kept.sort((a, b) => a.time - b.time);
}

/**
 * 找出与切点冲突的字幕（逐条切点 × 逐条字幕）：
 *  - span：切点严格落在字幕区间内部（跨越切点）；
 *  - start / end：切点与字幕始 / 末边界的距离严格小于容差。
 * 一条字幕可与多个切点冲突，产生多条结果；结果按切点时间、字幕开始时间排序。
 */
export function matchConflicts(
  cuts: ReadonlyArray<ShotCut>,
  subs: ReadonlyArray<Subtitle>,
  toleranceMs: number
): ShotConflict[] {
  const out: ShotConflict[] = [];
  for (const cut of cuts) {
    const t = cut.time;
    for (const s of subs) {
      let type: ShotConflictType | null = null;
      let distanceMs = 0;
      if (t > s.start && t < s.end) {
        type = 'span';
      } else if (Math.abs(t - s.start) < toleranceMs) {
        type = 'start';
        distanceMs = t - s.start;
      } else if (Math.abs(t - s.end) < toleranceMs) {
        type = 'end';
        distanceMs = t - s.end;
      }
      if (type) {
        out.push({
          cutTime: t,
          diff: cut.diff,
          type,
          subtitleId: s.id,
          index: s.index,
          start: s.start,
          end: s.end,
          text: s.text,
          distanceMs,
        });
      }
    }
  }
  const rank: Record<ShotConflictType, number> = { span: 0, start: 1, end: 2 };
  return out.sort(
    (a, b) =>
      a.cutTime - b.cutTime ||
      a.start - b.start ||
      rank[a.type] - rank[b.type]
  );
}
