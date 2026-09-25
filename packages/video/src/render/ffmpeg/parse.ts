import type { ProbeInfo } from "@mkt/contracts";
import type { LoudnormMeasured } from "./args.ts";

// Pure parsers for ffprobe JSON and ffmpeg's stderr reports.

type RawStream = {
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  bit_rate?: string;
  nb_frames?: string;
  sample_rate?: string;
  channels?: number;
};
type RawProbe = { streams?: RawStream[]; format?: { format_name?: string; duration?: string; size?: string; bit_rate?: string } };

const num = (s: string | number | undefined): number | null => {
  if (s === undefined || s === "N/A" || s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** "30000/1001" → 29.97. */
export function parseRate(r: string | undefined): number {
  if (!r) return 0;
  const [a, b] = r.split("/");
  const n = Number(a);
  const d = b === undefined ? 1 : Number(b);
  return d > 0 && Number.isFinite(n) ? n / d : 0;
}

/** ffprobe -show_streams -show_format -of json → ProbeInfo. faststart comes from the box scan. */
export function parseProbe(json: string, faststart: boolean | null = null): ProbeInfo {
  const raw = JSON.parse(json) as RawProbe;
  const streams = raw.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const fmt = raw.format ?? {};
  const rRate = parseRate(v?.r_frame_rate);
  const avgRate = parseRate(v?.avg_frame_rate);
  return {
    formatName: fmt.format_name ?? "",
    durationMs: Math.round((num(fmt.duration) ?? 0) * 1000),
    sizeBytes: num(fmt.size) ?? 0,
    bitRate: num(fmt.bit_rate),
    faststart,
    video: v
      ? {
          codec: v.codec_name ?? "",
          profile: v.profile ?? null,
          width: v.width ?? 0,
          height: v.height ?? 0,
          pixFmt: v.pix_fmt ?? null,
          fps: avgRate || rRate,
          cfr: rRate > 0 && Math.abs(rRate - avgRate) < 0.01,
          bitRate: num(v.bit_rate),
          frames: num(v.nb_frames),
        }
      : null,
    audio: a
      ? {
          codec: a.codec_name ?? "",
          profile: a.profile ?? null,
          sampleRate: num(a.sample_rate) ?? 0,
          channels: a.channels ?? 0,
          bitRate: num(a.bit_rate),
        }
      : null,
  };
}

/**
 * The JSON block loudnorm prints on stderr in pass 1 (the last `{...}` holding "input_i").
 * Returns null for silence (input_i "-inf"): there is nothing to normalise.
 */
export function parseLoudnormJson(stderr: string): LoudnormMeasured | null {
  const end = stderr.lastIndexOf("}");
  const start = end >= 0 ? stderr.lastIndexOf("{", end) : -1;
  if (start < 0) throw new Error("loudnorm printed no measurement");
  const obj = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
  if (!("input_i" in obj)) throw new Error("loudnorm measurement has no input_i");
  const val = (k: string) => {
    const s = obj[k];
    if (s === undefined) throw new Error(`loudnorm measurement is missing ${k}`);
    return s.trim() === "-inf" ? Number.NEGATIVE_INFINITY : Number(s);
  };
  const m = {
    inputI: val("input_i"),
    inputTp: val("input_tp"),
    inputLra: val("input_lra"),
    inputThresh: val("input_thresh"),
    targetOffset: val("target_offset"),
  };
  if (!Number.isFinite(m.inputI) || !Number.isFinite(m.inputTp) || !Number.isFinite(m.inputThresh)) return null;
  if (Object.values(m).some((x) => Number.isNaN(x))) throw new Error("loudnorm measurement has a non-number");
  return { ...m, targetOffset: Number.isFinite(m.targetOffset) ? m.targetOffset : 0, inputLra: Number.isFinite(m.inputLra) ? m.inputLra : 0 };
}

export type Loudness = { lufs: number; truePeak: number; lra: number | null };

/** ebur128=peak=true summary → integrated loudness (LUFS) and true peak (dBFS). */
export function parseEbur128(stderr: string): Loudness {
  const at = stderr.lastIndexOf("Summary:");
  if (at < 0) throw new Error("ebur128 printed no summary");
  const s = stderr.slice(at);
  const grab = (re: RegExp) => {
    const m = re.exec(s);
    if (!m?.[1]) return null;
    return m[1] === "-inf" ? Number.NEGATIVE_INFINITY : Number(m[1]);
  };
  const lufs = grab(/\bI:\s+(-inf|-?\d+(?:\.\d+)?)\s+LUFS/);
  const truePeak = grab(/\bPeak:\s+(-inf|-?\d+(?:\.\d+)?)\s+dBFS/);
  if (lufs === null || truePeak === null) throw new Error("ebur128 summary is missing loudness or peak");
  return { lufs, truePeak, lra: grab(/\bLRA:\s+(-?\d+(?:\.\d+)?)\s+LU\b/) };
}
