// Bounded local diagnostics. No photos, OCR text, route numbers or device identifiers.
const KEY = 'busvision.recognition.timings.v1';
export function readRecognitionTelemetry(storage = globalThis.localStorage) {
  try {
    const value = JSON.parse(storage.getItem(KEY) || '[]');
    return Array.isArray(value) ? value.slice(-100) : [];
  } catch { return []; }
}
export function recordRecognitionTelemetry(record, storage = globalThis.localStorage) {
  try {
    const records = readRecognitionTelemetry(storage);
    const allowed = ['source', 'outcome', 'stage', 'decodeMs', 'vehicleMs', 'roiMs', 'ocrMs', 'ocrSetupMs', 'preprocessMs', 'ocrEngineMs', 'pipelineMs', 'totalMs', 'attempted'];
    const clean = { at: new Date().toISOString(), version: '2.0.0-rc.37' };
    for (const key of allowed) {
      const value = record[key];
      if (typeof value === 'string' && !key.endsWith('Ms')) clean[key] = value.slice(0, 48);
      else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) clean[key] = Math.round(value);
    }
    storage.setItem(KEY, JSON.stringify([...records, clean].slice(-100)));
  } catch { /* Diagnostics must never prevent a recognition result. */ }
}
