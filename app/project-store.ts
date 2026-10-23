import { DEFAULT_PROJECT, validateProjectState } from "./ide-core.ts";
import type { ProjectState } from "./ide-core.ts";

interface StoredProject {
  id: string;
  state: ProjectState;
  updatedAt: number;
}

const DATABASE_NAME = "wasmbox-ide-projects";
const DATABASE_VERSION = 1;
const STORE_NAME = "projects";
const PROJECT_ID = "default";

let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDBを開けませんでした。"));
    request.onblocked = () => reject(new Error("別のタブがデータベースを使用中です。"));
  });

  databasePromise = opening.catch((error: unknown) => {
    databasePromise = undefined;
    throw error;
  });

  return databasePromise;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("保存処理に失敗しました。"));
    transaction.onabort = () => reject(transaction.error ?? new Error("保存処理が中断されました。"));
  });
}

export async function loadProjectState(): Promise<ProjectState> {
  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readonly");
  const request = transaction.objectStore(STORE_NAME).get(PROJECT_ID) as IDBRequest<StoredProject | undefined>;
  const stored = new Promise<StoredProject | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("プロジェクトを読み込めませんでした。"));
  });

  const [record] = await Promise.all([stored, transactionDone(transaction)]);
  if (!record || !record.state || validateProjectState(record.state)) {
    return structuredClone(DEFAULT_PROJECT);
  }

  return structuredClone(record.state);
}

export async function saveProjectState(state: ProjectState): Promise<void> {
  const problem = validateProjectState(state);
  if (problem) throw new Error(problem);

  const database = await openDatabase();
  const transaction = database.transaction(STORE_NAME, "readwrite", { durability: "strict" });
  transaction.objectStore(STORE_NAME).put({
    id: PROJECT_ID,
    state: structuredClone(state),
    updatedAt: Date.now(),
  } satisfies StoredProject);

  await transactionDone(transaction);
}
