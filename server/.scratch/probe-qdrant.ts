import { connect, disconnect } from "../src/db/client.ts";
import { initSettings, getSettings } from "../src/config/settings.ts";
import { ensureCollection, overwritePointPayload, targetCollection, upsertPoint, deletePoints, scrollAll } from "../src/services/footage/qdrant.ts";
import { pointIdFor } from "../src/services/footage/types.ts";

await connect();
await initSettings();
console.log("qdrant settings:", JSON.stringify(getSettings().qdrant));
await ensureCollection();
console.log("target collection:", targetCollection());

// Does overwritePayload on a MISSING point throw or silently no-op?
const missing = "vid-THIS-DOES-NOT-EXIST.mp4";
try {
  const id = await overwritePointPayload({
    local_file: missing, provider: "test", search_terms: ["x"],
    summary: "s", detailed_description: "d", use_cases: [], mood: [], tags: [],
    setting: "indoor", time_of_day: "day", has_people: false, has_on_screen_text: false,
    camera_motion: "static", quality_flags: [],
    describe_model: "m", describe_version: 1, embed_model: "e", embed_version: 1,
    indexed_at: new Date().toISOString(),
  });
  console.log("overwritePayload on missing point: RESOLVED, id =", id, "expected id =", pointIdFor(missing));
} catch (e) {
  console.log("overwritePayload on missing point: THREW:", (e as Error).name, (e as Error).message.slice(0, 300));
}

const after = await scrollAll();
console.log("points now in collection:", after.length, JSON.stringify(after.map((r) => r.payload?.local_file)));
await disconnect();
