// §5.7 stage 0: text and key UI must sit where no platform chrome covers it.
// Zones are defined on a 1080×1920 frame and scaled for other sizes of the same aspect.

export type Rect = { x: number; y: number; w: number; h: number };
export type SafeZonePlatform = "meta" | "tiktok" | "yt_short" | "all";

export const SAFE_FRAME = { width: 1080, height: 1920 } as const;

/** Right-hand action rail on TikTok and Shorts (like/comment/share). */
export const RIGHT_RAIL_PX = 130;

const rect = (x0: number, y0: number, x1: number, y1: number): Rect => ({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });

/** Pixel rects on 1080×1920. Meta: x 65–1015, y 269–1248 (Reels UI box). */
export const SAFE_ZONES: Record<SafeZonePlatform, Rect> = {
  meta: rect(65, 269, 1015, 1248),
  tiktok: rect(60, 160, 1080 - RIGHT_RAIL_PX, 1480),
  yt_short: rect(60, 180, 1080 - RIGHT_RAIL_PX, 1500),
  // Intersection of all three: what our templates lay text out in.
  all: rect(65, 269, 1080 - RIGHT_RAIL_PX, 1248),
};

export function intersect(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

/**
 * Safe rect in pixels for a frame. Vertical frames scale the 1080×1920 zones; square and
 * landscape frames (feeds, YouTube) only need a 5% margin.
 */
export function safeRect(platform: SafeZonePlatform, width: number = SAFE_FRAME.width, height: number = SAFE_FRAME.height): Rect {
  if (width / height > 0.6) {
    const mx = Math.round(width * 0.05);
    const my = Math.round(height * 0.05);
    return { x: mx, y: my, w: width - 2 * mx, h: height - 2 * my };
  }
  const zone = SAFE_ZONES[platform];
  const sx = width / SAFE_FRAME.width;
  const sy = height / SAFE_FRAME.height;
  return { x: zone.x * sx, y: zone.y * sy, w: zone.w * sx, h: zone.h * sy };
}

/** True when `box` (pixels on a width×height frame) lies fully inside the platform's safe zone. */
export function inSafeZone(box: Rect, platform: SafeZonePlatform, width: number = SAFE_FRAME.width, height: number = SAFE_FRAME.height): boolean {
  const z = safeRect(platform, width, height);
  const eps = 0.5;
  return box.x >= z.x - eps && box.y >= z.y - eps && box.x + box.w <= z.x + z.w + eps && box.y + box.h <= z.y + z.h + eps;
}

/** Fraction of `box` area outside the safe zone (0 = fully safe). */
export function outsideFraction(box: Rect, platform: SafeZonePlatform, width: number = SAFE_FRAME.width, height: number = SAFE_FRAME.height): number {
  const area = box.w * box.h;
  if (area <= 0) return 0;
  const inside = intersect(box, safeRect(platform, width, height));
  return 1 - (inside ? inside.w * inside.h : 0) / area;
}
