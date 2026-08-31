"use client";

export interface OcctMesh {
  name: string;
  color: [number, number, number] | null;
  attributes: {
    position: { array: number[] | Float32Array };
    normal?: { array: number[] | Float32Array };
  };
  index: { array: number[] | Uint32Array };
}

export interface OcctReadResult {
  success: boolean;
  meshes: OcctMesh[];
  root?: unknown;
}

interface OcctImportJsModule {
  ReadStepFile: (buffer: Uint8Array, params: Record<string, unknown> | null) => OcctReadResult;
}

type OcctImportJsFactory = (opts: { locateFile: (path: string) => string }) => Promise<OcctImportJsModule>;

declare global {
  interface Window {
    occtimportjs?: OcctImportJsFactory;
  }
}

let scriptPromise: Promise<OcctImportJsFactory> | null = null;
let modulePromise: Promise<OcctImportJsModule> | null = null;

function loadScript(): Promise<OcctImportJsFactory> {
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise((resolve, reject) => {
    if (window.occtimportjs) {
      resolve(window.occtimportjs);
      return;
    }
    const script = document.createElement("script");
    script.src = "/wasm/occt-import-js.js";
    script.async = true;
    script.onload = () => {
      if (window.occtimportjs) resolve(window.occtimportjs);
      else reject(new Error("occt-import-js.js loaded but did not define window.occtimportjs"));
    };
    script.onerror = () => reject(new Error("Failed to load /wasm/occt-import-js.js"));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

async function getOcctModule(): Promise<OcctImportJsModule> {
  if (modulePromise) return modulePromise;
  const factory = await loadScript();
  modulePromise = factory({ locateFile: () => "/wasm/occt-import-js.wasm" });
  return modulePromise;
}

/** Parses a STEP (.step/.stp) file buffer into triangle meshes in the browser
 * using the occt-import-js WASM build of OpenCascade. */
export async function parseStepFile(buffer: ArrayBuffer): Promise<OcctReadResult> {
  const occt = await getOcctModule();
  const bytes = new Uint8Array(buffer);
  const result = occt.ReadStepFile(bytes, null);
  if (!result.success) {
    throw new Error("Failed to parse STEP file. The file may be malformed or unsupported.");
  }
  return result;
}
