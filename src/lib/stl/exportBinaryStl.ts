/** Builds a binary STL Blob from indexed (or non-indexed) triangle position data. */
export function meshToBinaryStl(
  position: Float32Array,
  index: Uint32Array | Uint16Array | null
): Blob {
  const triCount = index ? index.length / 3 : position.length / 9;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triCount, true);

  const getVert = (i: number): [number, number, number] => {
    const base = i * 3;
    return [position[base], position[base + 1], position[base + 2]];
  };

  let offset = 84;
  for (let t = 0; t < triCount; t++) {
    let ia: number, ib: number, ic: number;
    if (index) {
      ia = index[t * 3];
      ib = index[t * 3 + 1];
      ic = index[t * 3 + 2];
    } else {
      ia = t * 3;
      ib = t * 3 + 1;
      ic = t * 3 + 2;
    }
    const a = getVert(ia);
    const b = getVert(ib);
    const c = getVert(ic);

    // Face normal via cross product (b-a) x (c-a)
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;

    view.setFloat32(offset, nx, true); offset += 4;
    view.setFloat32(offset, ny, true); offset += 4;
    view.setFloat32(offset, nz, true); offset += 4;

    for (const v of [a, b, c]) {
      view.setFloat32(offset, v[0], true); offset += 4;
      view.setFloat32(offset, v[1], true); offset += 4;
      view.setFloat32(offset, v[2], true); offset += 4;
    }
    offset += 2; // attribute byte count
  }

  return new Blob([buffer], { type: "model/stl" });
}
