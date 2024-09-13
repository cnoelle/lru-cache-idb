import { LruCacheIndexedDBImpl } from "./impl/CacheImpl.js";

export type Milliseconds = number;


/**
 * Configuration parameters for LruIdb
 */
export interface LruIdbConfig {

    /**
     * Default: "LruIdbItemsCache"
     */
    databaseName?: string;
    
    /**
     * Maximum number of items to be kept in the store. Note that this is not enforced strictly,
     * a clean up operation takes place regularly to purge the cache from old entries.
     * 
     * Default: 1000. Set to 0 to disable lru disposal and keep everything until deleted explicitly.
     */
    maxItems?: number;

    /**
     * In case the {@link LruIdbConfig.maxItems} threshold is violated, this number of entries will
     * be removed from the cache.
     * 
     * Default: 50 or maxItems/4, whichever is smaller.
     */
    numItemsToPurge?: number;

    /**
     * Persist lru information every X milliseconds. If set to 0, periodic persistence is disabled.
     * Default: 15_000 = 15s
     */
    persistencePeriod?: Milliseconds;

    /**
     * Batch eviction checks and operations. If this is set to a positive value, data eviction runs at most 
     * that often. In the meantime, the cache may grow beyond its specified capacity. If set to 0, items are deleted on every 
     * set operation if the cache is full, which may impede performance.
     * Default: 60_000 = 1min
     */
    evictionPeriod?: Milliseconds;

    /**
     * Check for mismatches between data stored and access times every x milliseconds. 
     * Default: 
     * 300_000 = 5min
     */
    cleanUpOrphanedPeriod?: Milliseconds;

    /**
     * When the page visibility changes to false (e.g. the user switching to another tab), persist current lru state?
     * Default: true
     */
//    persistOnVisibilityChange?: boolean;

    /**
     * Mostly for testing.
     * Default: globalThis.indexedDB
     */
    indexedDB?: {
        databaseFactory: IDBFactory;
        keyRange: /* Class<IDBKeyRange>*/ any;  // XXX can we really not avoid this?
    }
    //database?: IDBFactory;

    /** Keep items in memory? */
    memoryConfig?: boolean|{
        /**
         * Maximum number of items in memory. Default: 100.
         */
        maxItemsInMemory?: number;

        /**
         * Default: maxItemsInMemory/4
         */
        numMemoryItemsToPurge?: number;

        /**
         * TODO not used yet
         * By default uses structuredClone 
         * @param object 
         * @returns 
         */
        deepCopy?: (object: any) => any;
    }

}

export interface CacheRequestOptions {
    signal?: AbortSignal;
}

export interface CacheWriteOptions {
    /**
     * Relevant if periodic persistence is configured, which can be overwritten for individual write operations with this option.
     */
    persistImmediately?: boolean;
}

export interface OrderOptions {
    /**
     * By default, keys are returned in arbitrary order. Specifying this option leads to 
     * iteration order in terms of last access time.
     */
    // TODO test; desc not implemented
    orderByAccessTime?: "asc"|"desc";
}

export interface IterationOptions extends OrderOptions {
    /**
     * Default: 100
     */
    batchSize?: number; 

}

// do we need to expose access times?
/**
 * A least-recently-used (LRU) cache for the browser, based on IndexedDB.
 * All methods returning the cached values, such as {@link LruCacheIndexedDB.get LruCacheIndexedDB.get(key, options)}, reset the 
 * last access time of the respective entries, as do the setters. Methods iterating over keys, such as 
 * {@link LruCacheIndexedDB.keys LruCacheIndexedDB.iterateKeys(options)}, do not.
 */
export interface LruCacheIndexedDB<T> extends AsyncIterable<Array<string>> {

    /**
     * Get a cached value, if present, or undefined if not. Resets the last access time of the entry, if present.
     * @param key 
     * @param options 
     */
    get(key: string, options?: CacheRequestOptions): Promise<T|undefined>;
    /**
     * Like {@link get get()} but does not modify the access time of the entry.
     * @param key 
     * @param options 
     */
    peek(key: string, options?: CacheRequestOptions): Promise<T|undefined>;
    /**
     * Get multiple cached values at once. Resets the last access time of the present entries.
     * @param keys 
     * @param options 
     */
    getAll(keys: Array<string>, options?: CacheRequestOptions&{includeAbsent?: boolean}): Promise<Map<string, T|undefined>>;
    /**
     * Put a new entry into the cache. 
     * @param key 
     * @param value 
     * @param options 
     */
    set(key: string, value: T, options?: CacheRequestOptions&CacheWriteOptions): Promise<unknown>;
    /**
     * Put multiple entries into the cache.
     * @param entries 
     * @param options 
     */
    setAll(entries: Map<string, T>, options?: CacheRequestOptions&CacheWriteOptions): Promise<unknown>;
    /**
     * Returns an estimate of the number of items currently contained in the cache.
     * Under normal conditions, this should be smaller than the specified threshold {@link LruIdbConfig.maxItems},
     * but it may also occasionally exceed this value.
     * @param options 
     */
    size(options?: CacheRequestOptions): Promise<number>;
    /**
     * Retrieve all stored keys. Usually not recommended due its performance impact, prefer the streaming
     * or iterating methods {@link streamKeys streamKeys()}, {@link keys keys()} instead.
     * @param options 
     */
    getAllKeys(options?: CacheRequestOptions/*&OrderOptions*/): Promise<Array<string>>;  // TODO
    /**
     * Retrieve a stream of keys, optionally in the order of last access time.
     * @param options 
     */
    streamKeys(options?: IterationOptions): ReadableStream<Array<string>>;
    /**
     * See {@link streamKeys streamKeys()}
     * @param options 
     */
    streamValues(options?: IterationOptions): ReadableStream<Array<T>>;
    /**
     * See {@link streamKeys streamKeys()}
     * @param options 
     */
    streamEntries(options?: IterationOptions): ReadableStream<Map<string, T>>;
    /**
     * Iterate over keys in the cache, optionally in the order of last access time.
     * Note that this returns batches of keys in each step, typically around 100 per batch, 
     * since this is much more performant on large caches due to the promise overhead.
     * @param options 
     */
    keys(options?: IterationOptions): AsyncIterableIterator<Array<string>>;
    /**
     * See {@link keys keys()}. 
     * @param options 
     */
    values(options?: IterationOptions): AsyncIterableIterator<Array<T>>;
    /**
     * See {@link keys keys()}. 
     * @param options 
     */
    entries(options?: IterationOptions): AsyncIterableIterator<Map<string, T>>;

    /**
     * Iterate over keys in the cache, optionally in the order of last access time.
     * @param options 
     */
    [Symbol.asyncIterator](options?: IterationOptions): AsyncIterableIterator<Array<string>>;
    /**
     * Check if a key is contained in the cache. This does not change its access time.
     * @param options 
     */
    has(key: string, options?: CacheRequestOptions): Promise<boolean>;
    /**
     * Delete one or multiple entries.
     * @param keys 
     * @param options 
     */
    delete(keys: string|Array<string>, options?: CacheRequestOptions): Promise<number>;
    /**
     * Clear the cache.
     * @param options 
     */
    clear(options?: CacheRequestOptions): Promise<unknown>;
    /**
     * Close the cache.
     */
    close(): Promise<unknown>;

    computedConfig(): LruIdbConfig;

}

/**
 * This is the main entrypoint to the library, creating the cache.
 * @param config 
 * @returns 
 */
export function createCacheIdb<T>(config?: LruIdbConfig): LruCacheIndexedDB<T> {
    return new LruCacheIndexedDBImpl<T>(config);
}
