export interface BambuConnection {
  host: string;
  serial: string;
  accessCode: string;
}

export interface BambuStatus {
  connected: boolean;
  status: string;
  temperatures: {
    nozzle: { actual: number; target: number };
    bed: { actual: number; target: number };
  };
  print: {
    filename: string;
    progressPct: number;
    timeRemainingMin: number;
    currentLayer: number;
    totalLayers: number;
  };
  raw?: Record<string, unknown>;
  error?: string;
}
