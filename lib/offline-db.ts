import Dexie, { type Table } from "dexie";

export type OfflineQueueItem = {
  id?: number;
  userKey: string;
  type: "save_workout" | "save_body_weight";
  payload: unknown;
  createdAt: string;
};

export type CachedExerciseCatalogItem = {
  id: string;
  name: string;
  category: string | null;
  muscles: string[];
  equipment: string[];
  image_url: string | null;
  cachedAt: string;
};

class ProgressFitOfflineDb extends Dexie {
  queue!: Table<OfflineQueueItem, number>;
  exerciseCatalog!: Table<CachedExerciseCatalogItem, string>;

  constructor() {
    super("progressfit-offline");
    this.version(1).stores({
      queue: "++id,userKey,type,createdAt",
    });
    this.version(2).stores({
      queue: "++id,userKey,type,createdAt",
      exerciseCatalog: "id,name,cachedAt",
    });
  }
}

export const offlineDb = new ProgressFitOfflineDb();

export async function enqueueOffline(item: Omit<OfflineQueueItem, "createdAt">) {
  return offlineDb.queue.add({ ...item, createdAt: new Date().toISOString() });
}

export async function getOfflineQueueCount(userKey?: string) {
  if (!userKey) return offlineDb.queue.count();
  return offlineDb.queue.where("userKey").equals(userKey).count();
}

export async function cacheExerciseCatalog(items: Array<Omit<CachedExerciseCatalogItem, "cachedAt">>) {
  if (!items.length) return;
  const cachedAt = new Date().toISOString();
  await offlineDb.exerciseCatalog.bulkPut(items.map((item) => ({ ...item, cachedAt })));
}

export async function searchCachedExerciseCatalog(query: string, limit = 8) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const rows = await offlineDb.exerciseCatalog.toArray();
  return rows
    .filter((item) => item.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, limit);
}
