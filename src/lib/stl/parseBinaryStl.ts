import type { Triangle } from "@/lib/slicer/types";

/** Parses a binary or ASCII STL buffer into a flat triangle list. */
export function parseStl(buffer: ArrayBuffer): Triangle[] {
  if (isAsciiStl(buffer)) {
    return parseAsciiStl(buffer);
  }
  return parseBinaryStl(buffer);
}

function isAsciiStl(buffer: ArrayBuffer): boolean {
  // Binary STL: 80-byte header + uint32 triangle count + 50 bytes/triangle.
  // If the byte length matches that formula exactly, treat as binary even if
  // it happens to start with "solid" (some exporters do this).
  if (buffer.byteLength < 84) return true;
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const expectedBinarySize = 84 + triCount * 50;
  if (expectedBinarySize === buffer.byteLength) return false;

  const head = new TextDecoder().decode(buffer.slice(0, Math.min(5, buffer.byteLength)));
  return head.toLowerCase() === "solid";
}

function parseBinaryStl(buffer: ArrayBuffer): Triangle[] {
  const view = new DataView(buffer);
  const triCount = view.getUint32(80, true);
  const triangles: Triangle[] = [];
  let offset = 84;
  for (let i = 0; i < triCount; i++) {
    // skip normal (12 bytes)
    offset += 12;
    const a = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
    offset += 12;
    const b = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
    offset += 12;
    const c = { x: view.getFloat32(offset, true), y: view.getFloat32(offset + 4, true), z: view.getFloat32(offset + 8, true) };
    offset += 12;
    offset += 2; // attribute byte count
    triangles.push({ a, b, c });
  }
  return triangles;
}

function parseAsciiStl(buffer: ArrayBuffer): Triangle[] {
  const text = new TextDecoder().decode(buffer);
  const vertexRe = /vertex\s+([-\deE.+]+)\s+([-\deE.+]+)\s+([-\deE.+]+)/g;
  const verts: { x: number; y: number; z: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = vertexRe.exec(text)) !== null) {
    verts.push({ x: parseFloat(match[1]), y: parseFloat(match[2]), z: parseFloat(match[3]) });
  }
  const triangles: Triangle[] = [];
  for (let i = 0; i + 2 < verts.length; i += 3) {
    triangles.push({ a: verts[i], b: verts[i + 1], c: verts[i + 2] });
  }
  return triangles;
}
