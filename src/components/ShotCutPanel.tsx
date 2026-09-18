import { useMemo } from 'react';
import type { Subtitle } from '../types';
import { formatTimestamp } from '../srt';
import type { ShotScanState } from '../useShotScan';
import {
  matchConflicts,
  parseShotParams,
  type ShotConflict,
  type ShotConflictType,
} from '../shotcut';

export interface ShotForm {
  sampleMs: string;
  threshold: string;
  minGapMs: string;
  toleranceMs: string;
}

export const DEFAULT_SHOT_FORM: ShotForm = {
  sampleMs: '500',
  threshold: '0.3',
  minGapMs: '1000',
  toleranceMs: '300',
};

interface ShotCutPanelProps {
  subs: Subtitle[];
  videoName: string;
  form: ShotForm;
  onFormChange: (form: ShotForm) => void;
  scan: ShotScanState;
  selectedId: string | null;
  /** 点击切点 / 冲突条目：跳转播放头并（可选）选中字幕 */
  onSeek: (sec: number, subtitleId: string | null) => void;
  onStart: () => void;
  onCancel: () => void;
}

const CONFLICT_LABEL: Record<ShotConflictType, string> = {
  span: '跨越切点',
  start: '始边界过近',
  end: '末边界过近',
};

function formatDiff(d: number): string {
  return d.toFixed(3);
}

export default function ShotCutPanel({
  subs,
  videoName,
  form,
  onFormChange,
  scan,
  selectedId,
  onSeek,
  onStart,
  onCancel,
}: ShotCutPanelProps) {
  const parsed = parseShotParams(form);

  // 冲突列表始终基于「本次完成扫描时使用的参数」，避免扫描后改动输入框造成不一致
  const conflicts: ShotConflict[] = useMemo(() => {
    if (scan.status !== 'done' || !scan.params) return [];
    return matchConflicts(scan.cuts, subs, scan.params.toleranceMs);
  }, [scan, subs]);

  const cutCount = scan.cuts.length;
  const conflictCutIds = useMemo(
    () => new Set(conflicts.map((c) => c.cutTime)),
    [conflicts]
  );

  const update = (patch: Partial<ShotForm>) => onFormChange({ ...form, ...patch });

  const progress =
    scan.totalSec > 0 ? Math.min(1, scan.scannedSec / scan.totalSec) : 0;

  return (
    <aside className="shot-panel">
      <div className="shot-header">
        <span className="shot-title">镜头切点检查</span>
      </div>

      <div className="shot-body">
        <div className="shot-params">
          <label className="shot-param">
            <span>采样间隔（ms）</span>
            <input
              type="number"
              className="drift-input"
              step="50"
              min="1"
              value={form.sampleMs}
              onChange={(e) => update({ sampleMs: e.target.value })}
            />
          </label>
          <label className="shot-param">
            <span>差值阈值（0–1）</span>
            <input
              type="number"
              className="drift-input"
              step="0.02"
              min="0"
              max="1"
              value={form.threshold}
              onChange={(e) => update({ threshold: e.target.value })}
            />
          </label>
          <label className="shot-param">
            <span>最小切点间隔（ms）</span>
            <input
              type="number"
              className="drift-input"
              step="100"
              min="0"
              value={form.minGapMs}
              onChange={(e) => update({ minGapMs: e.target.value })}
            />
          </label>
          <label className="shot-param">
            <span>字幕边界容差（ms）</span>
            <input
              type="number"
              className="drift-input"
              step="50"
              min="0"
              value={form.toleranceMs}
              onChange={(e) => update({ toleranceMs: e.target.value })}
            />
          </label>
        </div>
        <div className="shot-hint dim">
          每隔采样间隔抽一帧缩放到固定尺寸，计算相邻帧 RGB 直方图差；超阈值候选在最小间隔内只保留差值最大者。全部分析仅在浏览器本地完成。
        </div>

        {!parsed.ok && <div className="drift-error">{parsed.error}</div>}

        {scan.status === 'scanning' && (
          <div className="shot-progress-block">
            <div className="shot-progress-head">
              <span className="spinner" />
              <span>
                正在扫描 {videoName}：{formatTimestamp(scan.scannedSec * 1000)} /{' '}
                {formatTimestamp(scan.totalSec * 1000)}
              </span>
              <b>{Math.round(progress * 100)}%</b>
            </div>
            <div className="shot-progress">
              <div className="shot-progress-bar" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        {scan.status === 'error' && (
          <div className="drift-error">扫描失败：{scan.error}</div>
        )}
        {scan.status === 'cancelled' && (
          <div className="shot-cancelled">已取消本次扫描，未保留切点结果</div>
        )}

        {scan.status === 'done' && scan.params && (
          <>
            <div className="drift-summary">
              <span>
                识别切点 <b>{cutCount}</b> 个 · 其中与字幕冲突{' '}
                <b>{conflictCutIds.size}</b> 个
              </span>
              <span>
                冲突字幕条目 <b>{conflicts.length}</b> 条
              </span>
              <span className="dim">
                采样 {scan.params.sampleMs}ms · 阈值 {scan.params.threshold} · 最小间隔{' '}
                {scan.params.minGapMs}ms · 容差 {scan.params.toleranceMs}ms
              </span>
            </div>

            <div className="shot-list">
              {conflicts.length === 0 && (
                <div className="merge-empty">✅ 没有跨越切点或边界贴近切点的字幕</div>
              )}
              {conflicts.map((c) => (
                <button
                  key={`${c.cutTime}-${c.subtitleId}-${c.type}`}
                  className={`shot-row conflict ${selectedId === c.subtitleId ? 'active' : ''}`}
                  onClick={() => onSeek(c.cutTime / 1000, c.subtitleId)}
                  title={`#${c.index}  ${formatTimestamp(c.start)} → ${formatTimestamp(c.end)}\n${c.text}`}
                >
                  <div className="shot-row-head">
                    <span className="shot-cut-time">🎬 {formatTimestamp(c.cutTime)}</span>
                    <span className={`shot-badge ${c.type}`}>{CONFLICT_LABEL[c.type]}</span>
                  </div>
                  <div className="shot-row-diff">
                    差值 {formatDiff(c.diff)}
                    {c.type !== 'span'
                      ? ` · 切点${c.distanceMs >= 0 ? '晚于' : '早于'}${
                          c.type === 'start' ? '始边界' : '末边界'
                        } ${Math.abs(c.distanceMs)}ms`
                      : ''}
                  </div>
                  <div className="shot-row-sub">
                    <span className="silence-row-idx">#{c.index}</span>
                    <span className="shot-sub-text">{c.text.split('\n')[0] || '（空文本）'}</span>
                  </div>
                </button>
              ))}

              {cutCount > conflictCutIds.size &&
                scan.cuts
                  .filter((cut) => !conflictCutIds.has(cut.time))
                  .map((cut) => (
                    <button
                      key={`free-${cut.time}`}
                      className="shot-row free"
                      onClick={() => onSeek(cut.time / 1000, null)}
                      title="该切点未与任何字幕冲突"
                    >
                      <div className="shot-row-head">
                        <span className="shot-cut-time">🎬 {formatTimestamp(cut.time)}</span>
                        <span className="shot-badge free">无冲突</span>
                      </div>
                      <div className="shot-row-diff">差值 {formatDiff(cut.diff)}</div>
                    </button>
                  ))}
            </div>
          </>
        )}
      </div>

      <div className="drift-footer">
        {scan.status === 'scanning' ? (
          <button className="btn danger" onClick={onCancel}>
            ⏹ 取消扫描（{Math.round(progress * 100)}%）
          </button>
        ) : (
          <button
            className="btn success"
            disabled={!parsed.ok}
            onClick={onStart}
            title={parsed.ok ? '按当前参数重新扫描整段视频' : parsed.error}
          >
            {scan.status === 'idle' ? '▶ 开始扫描' : '🔄 重新扫描'}
          </button>
        )}
        <div className="shot-footer-hint dim">
          分析只读、不修改字幕，不影响撤销历史；重新导入视频或调整参数会清空旧结果。
        </div>
      </div>
    </aside>
  );
}
