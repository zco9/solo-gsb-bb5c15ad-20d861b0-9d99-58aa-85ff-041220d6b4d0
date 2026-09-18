import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SHOT_FRAME_H,
  SHOT_FRAME_W,
  extractHistogram,
  histogramDistance,
  suppressCuts,
  type ShotCut,
  type ShotParams,
} from './shotcut';

export type ShotScanStatus = 'idle' | 'scanning' | 'done' | 'error' | 'cancelled';

export interface ShotScanState {
  status: ShotScanStatus;
  /** 本次扫描使用的参数（结果对应这套参数） */
  params: ShotParams | null;
  /** 已识别的切点（毫秒），结果按时间升序 */
  cuts: ShotCut[];
  /** 视频时长（秒） */
  duration: number;
  error: string | null;
  /** 已扫描时长（秒），用于进度条 */
  scannedSec: number;
  totalSec: number;
}

const IDLE: ShotScanState = {
  status: 'idle',
  params: null,
  cuts: [],
  duration: 0,
  error: null,
  scannedSec: 0,
  totalSec: 0,
};

interface Cancelled {
  cancelled: true;
}

/**
 * 镜头切点扫描状态机：idle → scanning → done / error / cancelled。
 * 扫描使用与播放分离的隐藏 <video>，仅读取本地 blob URL，
 * 逐帧 seek → 离屏 canvas 缩放到固定尺寸 → RGB 直方图差。
 * 每次 start 递增任务号；cancel / reset 使进行中的任务结果失效。
 */
export function useShotScan() {
  const [state, setState] = useState<ShotScanState>(IDLE);
  const jobRef = useRef(0);
  const cancelRef = useRef(false);

  /** 取消当前扫描（已抽出的帧一并丢弃） */
  const cancel = useCallback(() => {
    cancelRef.current = true;
  }, []);

  /** 清空结果（重新导入视频 / 修改参数时调用），并取消进行中的扫描 */
  const reset = useCallback(() => {
    cancelRef.current = true;
    jobRef.current++;
    setState(IDLE);
  }, []);

  const start = useCallback(
    async (url: string, params: ShotParams) => {
      const job = ++jobRef.current;
      cancelRef.current = false;
      setState({
        status: 'scanning',
        params,
        cuts: [],
        duration: 0,
        error: null,
        scannedSec: 0,
        totalSec: 0,
      });

      const video = document.createElement('video');
      video.muted = true;
      video.preload = 'auto';
      video.playsInline = true;
      const canvas = document.createElement('canvas');
      canvas.width = SHOT_FRAME_W;
      canvas.height = SHOT_FRAME_H;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      const cancelGuard = () => {
        if (jobRef.current !== job || cancelRef.current) {
          const err = new Error('cancelled') as Cancelled & Error;
          err.cancelled = true;
          throw err;
        }
      };

      const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

      const waitLoaded = (): Promise<number> =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            if (Number.isFinite(video.duration) && video.duration > 0)
              resolve(video.duration);
            else reject(new Error('视频元数据加载超时，无法读取时长'));
          }, 15000);
          video.addEventListener(
            'loadedmetadata',
            () => {
              clearTimeout(timer);
              if (!Number.isFinite(video.duration) || video.duration <= 0) {
                reject(new Error('视频时长无效（可能是损坏或未完成编码的文件）'));
              } else {
                resolve(video.duration);
              }
            },
            { once: true }
          );
          video.addEventListener(
            'error',
            () => {
              clearTimeout(timer);
              reject(new Error('浏览器无法解码该视频（编码格式可能不受支持）'));
            },
            { once: true }
          );
        });

      const seekFrame = (target: number): Promise<void> =>
        new Promise((resolve) => {
          let settled = false;
          const finish = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            video.removeEventListener('seeked', finish);
            resolve(); // 超时后以当前帧兜底，保证扫描能继续
          };
          const timer = setTimeout(finish, 3000);
          video.addEventListener('seeked', finish, { once: true });
          video.currentTime = target;
        });

      const cleanupVideo = () => {
        video.pause();
        video.removeAttribute('src');
        video.load(); // 释放解码器与已缓冲数据
      };

      try {
        if (!ctx) throw new Error('无法创建离屏画布（浏览器不支持 Canvas 2D）');
        video.src = url;
        const durationSec = await waitLoaded();
        cancelGuard();

        const durationMs = durationSec * 1000;
        setState((s) => ({ ...s, duration: durationSec, totalSec: durationSec }));

        const times: number[] = [];
        for (let t = 0; t <= durationMs; t += params.sampleMs) times.push(t);

        const candidates: ShotCut[] = [];
        let prevHist: Uint32Array | null = null;
        let lastReport = 0;

        for (let i = 0; i < times.length; i++) {
          cancelGuard();
          await seekFrame(times[i] / 1000);
          // 极端情况下 seek 超时且当前帧仍未解码：跳过本帧
          if (video.readyState >= 2 && video.videoWidth > 0) {
            ctx.drawImage(video, 0, 0, SHOT_FRAME_W, SHOT_FRAME_H);
            const hist = extractHistogram(ctx, SHOT_FRAME_W, SHOT_FRAME_H);
            if (prevHist) {
              const diff = histogramDistance(prevHist, hist);
              if (diff > params.threshold) candidates.push({ time: times[i], diff });
            }
            prevHist = hist;
          }
          const sec = times[i] / 1000;
          if (sec - lastReport >= 0.1 || i === times.length - 1) {
            lastReport = sec;
            setState((s) => ({ ...s, scannedSec: sec }));
            await wait(0); // 让出主线程，使进度条 / 取消按钮可响应
          }
        }

        cancelGuard();
        const cuts = suppressCuts(candidates, params.minGapMs);
        cleanupVideo();
        setState({
          status: 'done',
          params,
          cuts,
          duration: durationSec,
          error: null,
          scannedSec: durationSec,
          totalSec: durationSec,
        });
      } catch (err) {
        cleanupVideo();
        if (err instanceof Error && (err as Cancelled & Error).cancelled) {
          if (jobRef.current === job) {
            setState((s) => ({
              status: 'cancelled',
              params,
              cuts: [],
              duration: s.duration,
              error: null,
              scannedSec: s.scannedSec,
              totalSec: s.totalSec,
            }));
          }
          return;
        }
        if (jobRef.current !== job) return;
        setState((s) => ({
          status: 'error',
          params,
          cuts: [],
          duration: s.duration,
          error: err instanceof Error ? err.message : String(err),
          scannedSec: s.scannedSec,
          totalSec: s.totalSec,
        }));
      }
    },
    []
  );

  // 卸载时使进行中的任务失效（隐藏 video 由扫描结束 / 异常路径释放）
  useEffect(
    () => () => {
      jobRef.current++;
      cancelRef.current = true;
    },
    []
  );

  return { shot: state, startShot: start, cancelShot: cancel, resetShot: reset };
}
