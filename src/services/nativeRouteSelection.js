import { routeMatchesContext } from "./recognitionContext.js";
// Literal digits only. Never substitute letters for digits or prefer a specific route.
export function literalRouteCandidates(text) {
  const raw = String(text || "")
    .normalize("NFKC")
    .replace(/红/g, "紅")
    .replace(/绿/g, "綠")
    .replace(/蓝/g, "藍");
  if (
    /\d{5,}|\d{2,4}\s*[-－]\s*[A-Z]{1,3}|[A-Z]{2,3}\s*[-－]\s*\d{2,4}/i.test(
      raw,
    )
  )
    return [];
  const found = [];
  for (const match of raw.matchAll(
    /(?:藍|紅|綠|棕|橘|[Ff])?\s*\d{1,4}(?:副|區間|區|幹線)?/g,
  )) {
    const value = match[0].replace(/\s/g, "").toUpperCase(),
      digits = value.replace(/\D/g, "");
    if (
      digits.length < 3 &&
      !/^(藍|紅|綠|棕|橘|F)/.test(value) &&
      raw.trim() !== value
    )
      continue;
    if (
      digits.length === 4 &&
      /^20\d{2}$/.test(value) &&
      /年|日期|日期/.test(raw)
    )
      continue;
    found.push(value);
  }
  return [...new Set(found)];
}
export function selectNativeRoute(lines, width, height, context) {
  const candidates = [];
  const gps = context?.source === "gps";
  for (const line of lines || []) {
    if (
      !Number.isFinite(line.h) ||
      line.h < height * 0.012 ||
      line.y > height * 0.7
    )
      continue;
    for (const route of literalRouteCandidates(line.text)) {
      const exact =
        String(line.text).replace(/\s/g, "").normalize("NFKC") === route;
      const conf = Number.isFinite(line.confidence) ? line.confidence : 0;
      const score = Math.min(
        0.97,
        0.35 +
          Math.min(0.28, (line.h / height) * 2) +
          (1 - (line.y + line.h / 2) / height) * 0.15 +
          (exact ? 0.1 : 0) +
          Math.max(0, conf) * 0.12,
      );
      candidates.push({
        route,
        line,
        score,
        rank: score + (gps && routeMatchesContext(route, context) ? 0.04 : 0),
        ocrConfidence: conf,
        matches: gps || routeMatchesContext(route, context),
      });
    }
  }
  const sorted = candidates.sort((a, b) => b.rank - a.rank);
  const matching = sorted.filter((c) => c.matches),
    best = matching[0];
  const second = matching.find((c) => c.route !== best?.route);
  const reliable =
    !!best &&
    best.ocrConfidence >= 0.4 &&
    best.score >= 0.64 &&
    (!second || best.rank - second.rank >= 0.07);
  return {
    best,
    reliable,
    candidates: sorted,
    rejected: sorted.filter((c) => !c.matches).map((c) => c.route),
  };
}
