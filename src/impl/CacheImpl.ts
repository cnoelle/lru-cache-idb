import { CacheRequestOptions, CacheWriteOptions, IterationOptions, LruCacheIndexedDB, LruIdbConfig } from "../cache.js";
import { PeriodicTask } from "./PeriodicTask.js";
import { PersistenceOrchestrator } from "./PersistenceOrchestrator.js";
import { Table } from "./Table.js";
import { idle, TransformIterator, validateConfig } from "./Utils.js";

export type MillisecondsSinceEpoch = number;

interface CachedItem<T> {
    key: string;
    value: T;
    lastAccessed: MillisecondsSinceEpoch;
}


export class LruCacheIndexedDBImpl<T> implements LruCacheIndexedDB<T> {

    readonly #indexedDB: IDBFactory;
    readonly #IDBKeyRange: any;
    readonly #database: string;
    readonly #dbVersion: number = 1;
    readonly #itemsStorage: string;
    readonly #accessTimesStorage: string;
    readonly #config: LruIdbConfig;
    readonly #items: Table<T>;
    readonly #accessTimes: Table<{t: MillisecondsSinceEpoch}>;
    readonly #persistenceOrchestrator: PersistenceOrchestrator|undefined;
    readonly #dbLoader: (options?: CacheRequestOptions) => Promise<IDBDatabase>;

    readonly #eviction: PeriodicTask|undefined;
    // TODO interruptible?
    readonly #evictionTask = async () => {
        let deadline = await idle();
        const count = await this.#items.size();
        if (!(count > this.#config.maxItems!))
            return;
        deadline = deadline.timeRemaining() > 1 ? deadline : await idle();
        const diff = count + this.#config.numItemsToPurge! - this.#config.maxItems!;
        // note: this reads the first N keys from IndexedDB, so it takes into account potential changes from other browser sessions/tabs,
        // if they have been persisted already. In case of not immediate persistence there is however a time window for races.
        const firstNKeys = await this.#accessTimes.getFirstN("time", diff);
        deadline = deadline.timeRemaining() > 1 ? deadline : await idle();
        // synchronized deletion in a common transaction
        await PersistenceOrchestrator.delete([this.#items, this.#accessTimes], firstNKeys, await this.#dbLoader());
        /*
        await this.#items.delete(firstNKeys)
        deadline = deadline.timeRemaining() > 1 ? deadline : await idle();
        await this.#accessTimes.delete(firstNKeys);
        */
        if (this.#memory) {
            deadline = deadline.timeRemaining() > 1 ? deadline : await idle();
            firstNKeys.forEach(key => this.#memory?.delete(key));
        }
    };

    readonly #cleanUpOrphaned: PeriodicTask;
    /**
     * Check synchronization of items and accessKeys 
     */
    readonly #cleanUpOrphanedTask = async () => {
        let deadline = await idle();
        const sizes = await PersistenceOrchestrator.persistedSizes([this.#items, this.#accessTimes], await this.#dbLoader());
        if (new Set(sizes).size < 2)
            return;
        console.log("LruIdb found unequal IndexedDB sizes for cached items and access times", sizes[0], sizes[1]);
        const itemKeys = await this.#items.getAllKeys();
        const accessKeys = await this.#accessTimes.getAllKeys();
        deadline = deadline.timeRemaining() > 1 ? deadline : await idle();
        const itemKeysToDelete = itemKeys.filter(key => accessKeys.indexOf(key) < 0);
        const accessKeysToDelete = accessKeys.filter(key => itemKeys.indexOf(key) < 0);
        if (itemKeysToDelete.length > 0) {
            await this.#items.delete(itemKeysToDelete);
        }
        if (accessKeysToDelete.length > 0) {
            await this.#accessTimes.delete(accessKeysToDelete);

        }
    };

    readonly #initTimer: number;
    // memory cache
    readonly #memory: Map<string, CachedItem<T>>|undefined;
    readonly #maxMemorySize: number|undefined;
    readonly #numMemoryItemsToPurge: number|undefined;

    constructor(config?: LruIdbConfig) {
        this.#config = validateConfig(config);
        this.#maxMemorySize = (typeof(this.#config.memoryConfig) === "object") ? this.#config.memoryConfig.maxItemsInMemory || undefined : undefined;
        this.#memory = this.#maxMemorySize! > 0 ? new Map() : undefined;
        this.#numMemoryItemsToPurge = this.#maxMemorySize! > 0 ? this.#config.numItemsToPurge || Math.max(1, Math.round(this.#maxMemorySize!/4)) : undefined;
        this.#indexedDB = this.#config.indexedDB?.databaseFactory!;
        this.#IDBKeyRange = this.#config.indexedDB?.keyRange!;
        this.#database = this.#config.databaseName!;
        this.#itemsStorage = "Items";
        this.#accessTimesStorage = "AccessTimes";
        const dbLoader = (options?: CacheRequestOptions) => this.#openDb(options);
        this.#dbLoader = dbLoader;
        this.#items = new Table<T>({IDBKeyRange: this.#IDBKeyRange, id: "CachedItems", database: this.#database, objectStore: this.#itemsStorage, persistencePeriod: this.#config.persistencePeriod, 
            dbLoader: dbLoader});
        this.#accessTimes = new Table<{t: MillisecondsSinceEpoch}>({IDBKeyRange: this.#IDBKeyRange, id: "CachedItemAccessTime", database: this.#database, objectStore: this.#accessTimesStorage, 
            indexes: new Map([["time", {key: "t", unique: false}]]), persistencePeriod: this.#config.persistencePeriod,
            dbLoader: dbLoader});
        const cleanUpNeeded: boolean = this.#config.maxItems! > 0 && this.#config.evictionPeriod! > 0
        this.#eviction = cleanUpNeeded ? new PeriodicTask("LruIdbCleanUp", this.#config.evictionPeriod!, () => this.#evictionTask()) : undefined;
        this.#cleanUpOrphaned = new PeriodicTask("LruIdbCleanUpOrphaned", this.#config.cleanUpOrphanedPeriod!, () => this.#cleanUpOrphanedTask());
        this.#persistenceOrchestrator = this.#config.persistencePeriod! > 0 ? 
            new PersistenceOrchestrator([this.#items.getPersistenceTask()!, this.#accessTimes.getPersistenceTask()!], this.#config.persistencePeriod!, dbLoader)  : undefined;

        this.#initTimer = setTimeout(() => this.#cleanUpOrphaned.trigger(), 20_000);
    }

    computedConfig() {
        const copy: LruIdbConfig = {...this.#config};
        if (copy.indexedDB)
            copy.indexedDB = {...copy.indexedDB!};
        if (typeof(copy.memoryConfig) === "object")
            copy.memoryConfig = {...copy.memoryConfig};
        return copy
    }

    peek(key: string, options?: CacheRequestOptions): Promise<T | undefined> {
        return this.get(key, options, true);
    }
    
    async get(key: string, options?: CacheRequestOptions, noUpdate?: boolean): Promise<T | undefined> {
        const now = Date.now();
        const inMemory = this.#memory?.has(key);
        let item: T|undefined;
        if (inMemory) {
            const entry = this.#memory!.get(key);
            item = entry!.value;
            if (!noUpdate)
                entry!.lastAccessed = now;
        }
        item = item || await this.#items.get(key, options);
        if (item && !noUpdate) {
            // do not wait
            this.#accessTimes.set(key, {t: now}, options).catch(e => console.log("Failed to set access time for", key, e));
            if (!inMemory)
                this.#memory?.set(key, {key: key, value: item, lastAccessed: now});
        }
        return item;
    }

    async getAll(keys: Array<string>, options?: CacheRequestOptions&{includeAbsent?: boolean}): Promise<Map<string, T|undefined>> {
        if (keys.length === 0)
            return Promise.resolve(new Map());
        const now = Date.now();
        let result: Map<string, T|undefined>|undefined;
        if (this.#memory) {
            const entries = keys
                .filter(key => this.#memory?.has(key))
                .map(key => [key, this.#memory?.get(key)!] as [string, CachedItem<T>])
            if (entries.length > 0) {
                result = new Map(entries.map(([key, value]) => [key, value.value]));
                entries.map(([key, value]) => value).forEach(val => val.lastAccessed = now);
                keys = keys.filter(key => !result!.has(key));
                if (keys.length === 0)
                    return result;
            }
        }
        const persistent = await this.#items.getAll(keys, options);
        if (result)
            persistent.forEach((value, key) => result!.set(key, value));
        else
            result = persistent;
        const timeEntry = {t: Date.now()};
        const accessTimes = new Map(Array.from(result.keys()).map(key => [key, timeEntry]));
        // update access times
        this.#accessTimes.setAll(accessTimes, options).catch(e => console.log("Error setting lru-idb access times", e));  // do not wait
        if (this.#memory) {
            persistent.forEach((value, key) => {
                if (value)
                    this.#memory?.set(key, {key: key, value: value, lastAccessed: now});
            });
        }
        return result;
    }

    async set(key: string, value: T, options?: CacheRequestOptions&CacheWriteOptions): Promise<unknown> {
        const now = Date.now();
        // case 1: delayed persistence
        if (this.#persistenceOrchestrator && !options?.persistImmediately) { 
            const options2 = {persistence: this.#persistenceOrchestrator};
            options = options ? {...options, ...options2} : options2 as any;
            await Promise.all([this.#items.set(key, value, options), this.#accessTimes.set(key, {t: now}, options)]);
        } else { // case 2: immediate persistence
            const entries = new Map<Table<any>, Map<string, any>>([[this.#items, new Map([[key, value]])], [this.#accessTimes, new Map([[key, {t: now}]])]]);
            await PersistenceOrchestrator.persistImmediately(entries, await this.#dbLoader(), options);
        }
        this.#memory?.set(key, {key: key, value: value, lastAccessed: now});
        this.#cleanUpAfterSet();
        return undefined;
    }

    async setAll(entries: Map<string, T>, options?: CacheRequestOptions&CacheWriteOptions): Promise<unknown> {
        if (entries.size === 0)
            return undefined;
        const now = Date.now();
        const timeEntry = {t: now};
        const accessTimes = new Map(Array.from(entries.keys()).map(key => [key, timeEntry]));
        // case 1: delayed persistence
        if (this.#persistenceOrchestrator && !options?.persistImmediately) { 
            const options2 = {persistence: this.#persistenceOrchestrator};
            options = options ? {...options, ...options2} : options2 as any;
            await Promise.all([this.#items.setAll(entries, options), this.#accessTimes.setAll(accessTimes, options)]);
        } else { // case 2: immediate persistence
            const fullEntries = new Map<Table<any>, Map<string, any>>([[this.#items, entries], [this.#accessTimes, accessTimes]]);
            await PersistenceOrchestrator.persistImmediately(fullEntries, await this.#dbLoader(), options);
        }
        if (this.#memory)
            entries.forEach((value, key) => this.#memory?.set(key, {key: key, value: value, lastAccessed: now}));
        this.#cleanUpAfterSet();
        return undefined;
    }

    #cleanUpAfterSet() {
        this.#eviction?.trigger();
        idle().then(() => {
            if (!this.#eviction)
                this.#evictionTask().catch(e => console.log("Error in lru-idb clean up", e)); 
            if (this.#memory?.size! > this.#maxMemorySize!)
                this.#purgeMemory();
        }).catch(e => console.log("Error in lru-idb set", e)); // no wait
    }


    size(options?: CacheRequestOptions): Promise<number> {
        return this.#accessTimes.size(options);
    }

    getAllKeys(options?: CacheRequestOptions): Promise<Array<string>> {
        return this.#accessTimes.getAllKeys(options);
    }

    async delete(keys: string | Array<string>, options?: CacheRequestOptions): Promise<number> {
        if (typeof(keys) === "string")
            keys = [keys];
        if (this.#memory)
            keys.forEach(key => this.#memory!.delete(key));
        await PersistenceOrchestrator.delete([this.#items, this.#accessTimes], keys, await this.#dbLoader(), options);
        return 0; // TODO number?
    }

    async clear(options?: CacheRequestOptions): Promise<unknown> {
        this.#memory?.clear();
        return PersistenceOrchestrator.clear([this.#items, this.#accessTimes], await this.#dbLoader(), options);
    }

    close(): Promise<unknown> {
        globalThis.clearTimeout(this.#initTimer);
        const closer: Array<Promise<unknown>> = [this.#items.close(), this.#accessTimes.close()];
        if (this.#eviction)
            closer.push(this.#eviction!.close());
        if (this.#cleanUpOrphaned)
            closer.push(this.#cleanUpOrphaned!.close());
        this.#persistenceOrchestrator?.close();
        return Promise.all(closer);
    }

    streamKeys(options?: IterationOptions&{index?: string}): ReadableStream<Array<string>> {
        // it is better to base this on #items, since #accessTimes are written more often and will typically contain more orphaned entries
        // but if we need access time ordering, we need to go with accessTimes
        let table: Table<any> = this.#items;
        if (options?.orderByAccessTime) {
            if (options?.orderByAccessTime?.toLowerCase() === "desc")
                throw new Error("Descending iteration not implemented");
            options.index = "time";
            table = this.#accessTimes;
        }
        
        return table.streamKeys(options);
    }

    streamValues(options?: IterationOptions): ReadableStream<Array<T>> {
        return this.streamKeys(options).pipeThrough(new TransformStream({
            transform: async (chunk: Array<string>, controller: TransformStreamDefaultController<Array<T>>) => {
                const values = await this.#items.getAll(chunk);
                controller.enqueue(Array.from(values.values()) as Array<T>);
            }
        }));
    }

    streamEntries(options?: IterationOptions): ReadableStream<Map<string, T>> {
        return this.streamKeys(options).pipeThrough(new TransformStream({
            transform: async (chunk: Array<string>, controller: TransformStreamDefaultController<Map<string, T>>) => {
                const values = await this.#items.getAll(chunk);
                controller.enqueue(values as Map<string, T>);
            }
        }));
    }

    keys(options?: IterationOptions): AsyncIterableIterator<Array<string>> {
        return this[Symbol.asyncIterator](options);
    }

    values(options?: IterationOptions): AsyncIterableIterator<Array<T>> {
        return new TransformIterator<Array<string>, Array<T>>(this.keys(options), async keys => {
            const values = await this.#items.getAll(keys);
            return Array.from(values.values()) as Array<T>;
        });
    }

    entries(options?: IterationOptions): AsyncIterableIterator<Map<string, T>> {
        return new TransformIterator<Array<string>, Map<string, T>>(this.keys(options), async keys => this.#items.getAll(keys) as Promise<Map<string, T>>);
    }

    [Symbol.asyncIterator](options?: IterationOptions&{index?: string}): AsyncIterableIterator<Array<string>> {
        let table: Table<any> = this.#items;
        if (options?.orderByAccessTime) {
            if (options?.orderByAccessTime?.toLowerCase() === "desc")
                throw new Error("Descending iteration not implemented");
            options = {...options, index: "time"};
            table = this.#accessTimes;
        }
        return table[Symbol.asyncIterator](options);
    }

    has(key: string, options?: CacheRequestOptions): Promise<boolean> {
        if (this.#memory?.has(key))
            return Promise.resolve(true);
        return this.#items.has(key, options);
    }

    // for testing
    __isPersisted__(): boolean {
        return this.#items.isPersisted();
    }

    #purgeMemory() {
        const diff: number = this.#memory?.size! - this.#maxMemorySize!;
        if (!(diff > 0))
            return;
        const toRemove = diff + this.#numMemoryItemsToPurge!;
        // sort according to last access time
        let keysSorted = Array.from(this.#memory!.entries())
            .sort(([key1, value1], [key2, value2]) => value1.lastAccessed - value2.lastAccessed)
            .map(([key, value]) => key);
        if (keysSorted.length > toRemove)
            keysSorted = keysSorted.slice(0, toRemove);
        keysSorted.forEach(key => this.#memory!.delete(key));
    }

    readonly #openDb = (options?: CacheRequestOptions): Promise<IDBDatabase> => {
        const dbPromise: Promise<IDBDatabase> = new Promise((resolve, reject) => {
            const request: IDBOpenDBRequest = this.#indexedDB.open(this.#database, this.#dbVersion);
            request.onupgradeneeded = (event) => {
                const db: IDBDatabase = (event.target as any).result;
                const objectStore = db.createObjectStore(this.#itemsStorage /*, { keyPath: "key" }*/);
                const timesStore = db.createObjectStore(this.#accessTimesStorage);
                timesStore.createIndex("time", "t", {unique: false});
            };
            request.onerror = reject;
            options?.signal?.addEventListener("abort", reject, {once: true});
            request.onsuccess = event => {
                resolve((event.target as any).result as IDBDatabase);
                options?.signal?.removeEventListener("abort", reject);
            };
        });
        return dbPromise;
    };

}
