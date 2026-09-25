import { describe, expect, it } from "vitest";
import { ffmpegImageTools, grayscaleArgs, toJpegArgs } from "./image.ts";

describe("ffmpeg image argv", () => {
  it("decodes one frame to exact-size raw gray", () => {
    const a = grayscaleArgs("in", "out.gray", 32, 32);
    expect(a).toContain("scale=32:32:flags=area,format=gray");
    expect(a.slice(-3)).toEqual(["-f", "rawvideo", "out.gray"]);
  });

  it("fits inside the box without upscaling and maps quality to qscale", () => {
    const a = toJpegArgs("in", "out.jpg", 1280, 1280, 80);
    expect(a.join(" ")).toContain("min(1280,iw)");
    expect(a.join(" ")).toContain("force_original_aspect_ratio=decrease");
    expect(a[a.indexOf("-q:v") + 1]).toBe("8");
    expect(toJpegArgs("i", "o", 1, 1, 100)[toJpegArgs("i", "o", 1, 1, 100).indexOf("-q:v") + 1]).toBe("2");
  });

  it("rejects a decode of the wrong size", async () => {
    const { decoder } = ffmpegImageTools({
      run: async (_bin, args) => {
        const { writeFile } = await import("node:fs/promises");
        await writeFile(args[args.length - 1]!, new Uint8Array(10));
        return { stdout: "", stderr: "" };
      },
    });
    await expect(decoder.grayscale(new Uint8Array([1, 2, 3]), 4, 4)).rejects.toThrow(/expected 16/);
  });
});
