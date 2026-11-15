// Preserve an exact OCR route before applying ambiguous LED shape corrections.
// The accepted route lengths and prefixes match the existing normalizer.
export function extractLiteralRouteText(text) {
  const raw = String(text || '').trim().replace(/Ｆ/g, 'F');
  const exact = raw.match(/^((?:藍|紅|綠|棕|橘)?[Ff]?)(\d{2,4})(副|區間|區|幹線)?$/);
  if (exact && (exact[1] || exact[2].length >= 3)) {
    return raw.toUpperCase();
  }

  // Preserve the existing correction for a separated artifact such as "4 921".
  // Contiguous four-digit routes are handled by the exact match above.
  const separated = raw.match(/^\d\s+(9\d{2})$/);
  return separated?.[1] || '';
}
