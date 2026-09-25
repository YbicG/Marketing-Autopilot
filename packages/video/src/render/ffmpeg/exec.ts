import { execFile } from "node:child_process";

/** Runs a binary with an argv array (never a shell). Injected in tests. */
export type Runner = (bin: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

export const defaultRunner: Runner = (bin, args) =>
  new Promise((resolve, reject) => {
    execFile(bin, [...args], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        // ffmpeg's reason is at the end of stderr.
        const tail = String(stderr).split("\n").slice(-8).join("\n");
        reject(new Error(`${bin} failed: ${err.message}\n${tail}`));
      } else resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });

/** Binary paths (default: on PATH, as in the worker image) and the runner. */
export type FfTools = { ffmpegPath?: string; ffprobePath?: string; run?: Runner };

export const tools = (t: FfTools = {}) => ({
  ffmpeg: t.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg",
  ffprobe: t.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe",
  run: t.run ?? defaultRunner,
});
