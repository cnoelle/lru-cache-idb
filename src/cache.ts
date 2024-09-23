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
     * Default: "".
     * The prefix will be prepended to "Items" and "AccessTimes" to generate the names
     * for the two IndexedDB object stores used.
     */
    tablePrefix?: string;

    /**
     * When using multiple caches with different table names but the same database in a single app, then
     * it is more efficient to pass all the tables here, so they can be created right at the start. 
     * This is not strictly required, however, if a table for some cache is missing it will be created
     * later, resulting in an IndexedDB version update.
     */
    tablePrefixesUsed?: Array<string>;

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
     * Mostly for testing.
     * Default: globalThis.indexedDB
     */
    indexedDB?: {
        databaseFactory: IDBFactory;
        keyRange: /* Class<IDBKeyRange>*/ any;  // XXX can we really not avoid this?
    }

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

    },

    /**
     * Return copies of the stored values if they come from memory, so that the caller
     * can modify them without impacting the stored values 
     * (there is no need to copy values restored from persistence).
     * The function used to copy values is [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone),
     * unless a custom {@link deepCopy} function is provided.
     * 
     * If this is false and items are kept in memory (which can happen due to periodic persistence, see {@link persistencePeriod}, and/or 
     * due to {@link memoryConfig}), then the caller should avoid modifying objects returned from the cache.
     * 
     * Default is false.
     */
    copyOnReturn?: boolean;
    /**
     * Copy values upon insertion.
     * The function used to copy values is [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone),
     * unless a custom {@link deepCopy} function is provided.
     * 
     * If this is false and items are kept in memory (which can happen due to periodic persistence, see {@link persistencePeriod}, and/or 
     * due to {@link memoryConfig}), then the caller should avoid modifying objects that have been passed to the cache.
     * 
     * Default is false.
     */
    copyOnInsert?: boolean;

    /**
     * Only relevant if {@link copyOnReturn} is true or {@link copyOnInsert} is true.
     * By default it uses the global [`structuredClone`](https://developer.mozilla.org/en-US/docs/Web/API/structuredClone) function.
     * @param object 
     * @returns 
     */
    deepCopy?: (object: any) => any;

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
     * Close the cache. Note that this will trigger the persistence, so it should be good practice to 
     * close the cache explicitly before 
     */
    close(): Promise<unknown>;

    /**
     * If the configured persistence interval is positive, this method can be used
     * to trigger an immediate persistence of the stored data.
     */
    persist(): Promise<unknown>;

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

