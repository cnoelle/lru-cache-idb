import { LruIdbConfig } from "../cache.js";

const defaultConfig: LruIdbConfig = {
    databaseName: "LruIdbItemsCache",
    maxItems: 1000,
    persistencePeriod: 15_000,
    evictionPeriod: 60_000,
    cleanUpOrphanedPeriod: 300_000,
    //persistOnVisibilityChange: true,
    memoryConfig: false
}


export interface ValidatedLruIdbConfig extends LruIdbConfig {
    itemsStorage: string;
    accessTimesStorage: string;
    allRequestedObjectStorages: Array<string>;  /* generated from tablePrefix and tablePrefixesUsed */
    databaseName: string;  // not optional
    indexedDB: {           // not optional
        databaseFactory: IDBFactory;
        keyRange: /* Class<IDBKeyRange>*/ any;
    }
}

export function validateConfig(config?: LruIdbConfig): ValidatedLruIdbConfig {
    // @ts-ignore
    const cfg: ValidatedLruIdbConfig = config ? {...defaultConfig, ...config} : {...defaultConfig};
    if (cfg.indexedDB === undefined)
        cfg.indexedDB = {
            databaseFactory: globalThis.indexedDB,
            keyRange: globalThis.IDBKeyRange
        } 
        if (cfg.indexedDB?.databaseFactory === undefined || cfg.indexedDB?.keyRange === undefined) {
            throw new Error("IndexedDB not available, please provide a polyfill via the `database` parameter.")
        }
    if (typeof(config?.memoryConfig) === "object")
        cfg.memoryConfig = {...config.memoryConfig};
    if (!(cfg.maxItems! > 0) || !Number.isInteger(cfg.maxItems))
        throw new Error("maxItems must be a positive integer, got " + config?.maxItems);
    if (cfg.numItemsToPurge === undefined)
        cfg.numItemsToPurge = Math.min(50, Math.max(Math.round(cfg.maxItems!/4), 1));
    if (!(cfg.numItemsToPurge > 0))
        throw new Error("numItemsToPurge must be a positive integer, got " + config?.maxItems);
    if (cfg.memoryConfig === true)
        cfg.memoryConfig =  {maxItemsInMemory: 100};
    if (typeof(cfg.memoryConfig) === "object") {
        const memory = cfg.memoryConfig;
        if (memory.maxItemsInMemory === undefined)
            memory.maxItemsInMemory = 100;
        if (!(memory.maxItemsInMemory! >= 0) || !Number.isInteger(memory.maxItemsInMemory))
            throw new Error("maxItemsInMemory must be a non-negative integer, got " + memory.maxItemsInMemory);
        if (memory.maxItemsInMemory === 0) {
            cfg.memoryConfig = false;
        } else {
            if (memory.numMemoryItemsToPurge === undefined)
                memory.numMemoryItemsToPurge = Math.max(1, Math.round(memory.maxItemsInMemory!/4));
            if (!(memory.numMemoryItemsToPurge > 0))
                throw new Error("numMemoryItemsToPurge must be a positive integer, got " + memory.numMemoryItemsToPurge);
        }
    }
    const needCopy: boolean = (cfg.copyOnReturn === true || cfg.copyOnInsert === true) && (!!cfg.memoryConfig || cfg.persistencePeriod! > 0);
    if (!needCopy) {
        cfg.deepCopy = undefined;
    } else {
        cfg.deepCopy = cfg.deepCopy || globalThis.structuredClone;
        if (cfg.deepCopy === undefined)
            throw new Error("structuredClone not available, setting memoryConfig.copyOnReturn = true requires a custom deepCopy function.")
    }
    cfg.copyOnReturn = cfg.copyOnReturn ?? false;
    cfg.copyOnInsert = cfg.copyOnInsert ?? false;
    const prefix = cfg.tablePrefix || "";
    cfg.itemsStorage = prefix + "Items";
    cfg.accessTimesStorage = prefix + "AccessTimes";
    const allRequestedObjectStorages = [cfg.itemsStorage, cfg.accessTimesStorage];
    if (cfg.tablePrefixesUsed) {
        for (const otherPrefix of cfg.tablePrefixesUsed) {
            if (otherPrefix === prefix)
                continue;
            allRequestedObjectStorages.push(...[otherPrefix + "Items", otherPrefix + "AccessTimes"]);
        }
    }
    cfg.allRequestedObjectStorages = allRequestedObjectStorages;
    return cfg;
}

const dummyDeadline: IdleDeadline|undefined = !!globalThis.requestIdleCallback ? undefined : {didTimeout: false, timeRemaining: () => 1_000};

export function idle(): Promise<IdleDeadline> {
    let requestIdle = globalThis.requestIdleCallback;
    if (!requestIdle)
        requestIdle = callback => setTimeout(() => callback(dummyDeadline!), 0)
    return new Promise(resolve => requestIdle(resolve));
}

export function queryIdbSingle<T>(db: IDBDatabase, store: string, mode: "readwrite"|"readonly", 
            operation: (base: IDBObjectStore|IDBIndex) => IDBRequest<T>,  options?: {index?: string; signal?: AbortSignal;}): Promise<T> {
    const signal = options?.signal;
    const valuePromise = new Promise<T>((resolve, reject) => {
        const transaction = db.transaction([store], mode);
        transaction.onerror = reject;
        const abort = signal ? () => transaction.abort() : undefined;
        signal?.addEventListener("abort", abort!, {once: true});
        const objectStore = transaction.objectStore(store);
        const base: IDBObjectStore|IDBIndex = options?.index ? objectStore.index(options.index) : objectStore;
        const request: IDBRequest<T> = operation(base);
        request.onerror = e => {
            reject(e);
            signal?.removeEventListener("abort", abort!);
        };
        request.onsuccess = evt => resolve((evt.target as any).result);
        if (transaction.commit)
            transaction.commit();
    });
    return valuePromise;
}

export class TransformIterator<S, T> implements AsyncIterableIterator<T> {

    constructor(
        private readonly _source: AsyncIterableIterator<S>, 
        private readonly _trafo: (s: S) => Promise<T>,
        private readonly _options?: {skip?: (t: T) => boolean}) {}

    [Symbol.asyncIterator]() {
        return this;
    }

    async next(...args: [] | [undefined]): Promise<IteratorResult<T, any>> {
        const nextSourceResult = await this._source.next();
        if (nextSourceResult.done)
            return nextSourceResult;
        const nextSource: S = nextSourceResult.value;
        const result = await this._trafo(nextSource); 
        if (this._options?.skip && this._options?.skip(result))
            return this.next(...args);
        return {done: false, value: result};
    }

}

