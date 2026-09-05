import type { Loop, SliceResult, Vec2 } from "./types";

/**
 * One layer's extrusion moves, split by role, as flat coordinate arrays:
 * every four numbers `[x1, y1, x2, y2]` are one segment.
 *
 * The old preview payload shipped `{x, y}` objects and dropped infill
 * entirely to keep the response small, which is why the preview could only
 * ever show wall outlines. Flat, rounded arrays are roughly an order of
 * magnitude smaller per point, so the whole toolpath — infill included —
 * fits comfortably and the viewer can show what will actually be printed.
 */
export interface ToolpathLayer {
  z: number;
  outerWall: number[];
  innerWall: number[];
  solid: number[];
  infill: number[];
  support: number[];
}

/** 3 decimals is ~1 micron: far below what any FDM printer resolves, and it
 * roughly halves the JSON size versus full float precision. */
function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function pushSegment(out: number[], a: Vec2, b: Vec2): void {
  out.push(round(a.x), round(a.y), round(b.x), round(b.y));
}

function pushLoop(out: number[], loop: Loop): void {
  for (let i = 0; i < loop.length; i++) {
    pushSegment(out, loop[i], loop[(i + 1) % loop.length]);
  }
}

function pushSegments(out: number[], segments: [Vec2, Vec2][]): void {
  for (const [a, b] of segments) pushSegment(out, a, b);
}

export function buildToolpath(result: SliceResult): ToolpathLayer[] {
  return result.layers.map((layer) => {
    const outerWall: number[] = [];
    const innerWall: number[] = [];
    const solid: number[] = [];
    const infill: number[] = [];
    const support: number[] = [];

    // insets[0] is the outermost wall — the one whose quality the viewer
    // most wants to inspect — so it gets its own colour channel.
    for (const insets of layer.perimeters) {
      insets.forEach((loop, i) => pushLoop(i === 0 ? outerWall : innerWall, loop));
    }
    for (const insets of layer.supports) {
      for (const loop of insets) pushLoop(support, loop);
    }
    pushSegments(solid, layer.solid);
    pushSegments(infill, layer.infill);

    return { z: round(layer.z), outerWall, innerWall, solid, infill, support };
  });
}
