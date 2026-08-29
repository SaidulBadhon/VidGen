import { MongoClient } from "mongodb";
const c = new MongoClient("mongodb://127.0.0.1:27017");
await c.connect();
const dbs = await c.db().admin().listDatabases();
for (const d of dbs.databases) {
  if (["admin","local","config"].includes(d.name)) continue;
  const db = c.db(d.name);
  const names = (await db.listCollections().toArray()).map((x) => x.name);
  const counts: Record<string, number> = {};
  for (const n of names) counts[n] = await db.collection(n).countDocuments();
  console.log(d.name, JSON.stringify(counts));
}
await c.close();
