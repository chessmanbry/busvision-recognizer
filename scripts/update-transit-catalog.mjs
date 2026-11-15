// Refresh the offline route index from official Taipei/New Taipei feeds.
import { gunzipSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { normalizeRoutes, isNearCampus } from "../src/services/transitData.js";
const routes = (
  await Promise.all(
    Object.entries({ taipei: "blobbus", newtaipei: "ntpcbus" }).map(
      async ([city, folder]) => {
        const feeds = await Promise.all(
          ["GetRoute.gz", "GetStop.gz"].map(async (file) => {
            const r = await fetch(
              `https://tcgbusfs.blob.core.windows.net/${folder}/${file}`,
              { signal: AbortSignal.timeout(30000) },
            );
            if (!r.ok) throw new Error(`${city} ${r.status}`);
            return JSON.parse(
              gunzipSync(Buffer.from(await r.arrayBuffer())).toString(),
            ).BusInfo;
          }),
        );
        const ids = new Set(
          feeds[1].filter(isNearCampus).map((s) => String(s.routeId)),
        );
        return normalizeRoutes(feeds[0], city, ids);
      },
    ),
  )
).flat();
await writeFile(
  new URL("../src/data/taipeiRoutes.json", import.meta.url),
  JSON.stringify({
    updatedAt: new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Taipei",
    }),
    nearbyCenter: { lat: 24.9468, lon: 121.372, radiusKm: 1.2 },
    routes,
  }),
);
console.log(
  `Updated ${routes.length} routes; ${routes.filter((r) => r.nearby).length} near NTPU.`,
);
