import { CacheRequestOptions, CacheWriteOptions, IterationOptions, Milliseconds } from "../cache.js";
import { PersistenceOrchestrator } from "./PersistenceOrchestrator.js";
import { TableStream } from "./TableStream.js";

export interface TableConfig {
    IDBKeyRange: any;
    id: string;
    database: string;
    objectStore: string;
    version?: number; // starts at 1 (default)
    persistencePeriod?: Milliseconds;
    dbLoader: (options?: CacheRequestOptions) => Promise<IDBDatabase>;
    indexes?: Map<string, {key: /*keyof T*/string;}&IDBIndexParameters>;
}

export interface TransactionContext {
    setContext(ctx: any): void;
}

/**
 * Task to persist existing in-memory data
 */
export interface PersistenceTask {

    empty(): boolean;
    objectStore(): string;
    run(objectStore: IDBObjectStore, ctx: TransactionContext): IterableIterator<IDBRequest>|undefined;
    transactionCompleted(result: Promise<unknown>, transactionContext: any): void;

}

export interface TransactionOperation<T> {
    execute(objectStore: IDBObjectStore, entries: T): IterableIterator<IDBRequest>;
}

export class Table<T> /*implements LruCacheIndexedDB<T>*/ {

    readonly #IDBKeyRange: any;
    readonly #dbLoader: (options?: CacheRequestOptions) => Promise<IDBDatabase>;
    readonly #id: string;
    readonly #objectStore: string;
    readonly #indexes: Map<string, {key: /*keyof T*/string;}&IDBIndexParameters>|undefined;
    readonly #persistencePeriod: number|undefined;
    readonly #itemsForPersistence: Map<string, T>|undefined;
    // like a trash bin; if the last transaction failed, reconstruct them to memory
    //#itemsPassedToPersistence: Map<string, T>|undefined;

    readonly #persistence: PersistenceOrchestrator|undefined;
    readonly #persistenceTask: PersistenceTask|undefined;
    readonly #deleteTask: TransactionOperation<Array<string>>;
    readonly #immediatePersistenceTask: TransactionOperation<Map<string, T>>;

    constructor(options: TableConfig) {
        this.#dbLoader = options.dbLoader;
        this.#IDBKeyRange = options.IDBKeyRange;
        this.#id = options.id;
        this.#objectStore = options.objectStore;
        this.#indexes = options.indexes;
        if (options.persistencePeriod === 0)
            options.persistencePeriod = undefined;
        this.#persistencePeriod = options?.persistencePeriod;
        this.#itemsForPersistence = this.#persistencePeriod! > 0 ? new Map() : undefined;
        // @deprecated
        /*
        this.#persistence = this.#persistencePeriod! > 0 ? new PeriodicTask("Persistence_Table_" + this.#id, this.#persistencePeriod!, async () => {
            await this.#persistInternal(this.#itemsForPersistence!.entries()!);
            this.#itemsForPersistence!.clear();
        }) : undefined;
         */

        //const table = this;
        this.#persistenceTask = this.#persistencePeriod! > 0 ? {
            empty: () => !(this.#itemsForPersistence?.size! > 0),
            objectStore: () => this.#objectStore,
            run: (store: IDBObjectStore , ctx: TransactionContext) => {
                if (!(this.#itemsForPersistence?.size! > 0))
                    return undefined;
                // remember items relevant to this transaction, in order to remove them from memory once the transaction is complete
                const currentItems = new Map(this.#itemsForPersistence);
                ctx.setContext(currentItems);
                return new PersistenceExecution(store, currentItems.entries());
            },
            transactionCompleted: async (result: Promise<unknown>, ctx: any) => {
                try {
                    await result;
                    // success: delete items from memory
                    const itemsPersisted: Map<string, T> = ctx;
                    if (itemsPersisted) {
                        for (const key of itemsPersisted.keys()) {
                            this.#itemsForPersistence?.delete(key);
                        }
                    }
                } catch (e) {
                    // error: avoid deleting items from memory; nothing to do here
                }
            }
        } : undefined;
        this.#deleteTask = {
            execute: (objectStore: IDBObjectStore, keys: Array<string>) => new DeletionExecution(objectStore, keys[Symbol.iterator](), this.#itemsForPersistence)
        }
        this.#immediatePersistenceTask = {
            execute: (objectStore, entries)  => new ImmediatePersistenceExecution(objectStore, entries.entries(), this.#itemsForPersistence)
        }
    }

    getPersistenceTask(): PersistenceTask|undefined {
        return this.#persistenceTask;
    }

    getDeletionTask(): TransactionOperation<Array<string>> {
        return this.#deleteTask;
    }

    getImmediatePersistenceTask(): TransactionOperation<Map<string, T>> {
        return this.#immediatePersistenceTask;
    }

    getClearTask(): TransactionOperation<void> {
        return {
            execute: (objectStore: IDBObjectStore) => {
                let done: boolean = false;
                return {
                    [Symbol.iterator]() { return this; },
                    next: () => {
                        if (done)
                            return {done: true, value: undefined};
                        done = true;
                        this.#itemsForPersistence?.clear();
                        return {done: false, value: objectStore.clear()};
                    }
                }
            },
        }
    }

    objectStore(): string {
        return this.#objectStore;
    }

    async getFirstN(index: string, n: number, options?: CacheRequestOptions): Promise<Array<string>> {
        const result = [];
        for await (const batch of this.keys({index: index, batchSize: n})) {
            if (batch.length > n - result.length) {
                batch.splice(n - result.length);
            }
            result.push(...batch);
            if (result.length >= n)
                break;
        }
        return result;
    }

    peek(key: string, options?: CacheRequestOptions): Promise<T | undefined> {
        return this.get(key, options);
    }

    async get(key: string, options?: CacheRequestOptions&{deepCopy?: Function;}): Promise<T|undefined> {
        if (this.#itemsForPersistence?.has(key)) {
            const item = this.#itemsForPersistence.get(key)!;
            return Promise.resolve(options?.deepCopy ? options.deepCopy(item) : item);
        }
        const item = await this.#getInternal(key, options);  
        return item;
    }

    async getAll(keys: Array<string>, options?: CacheRequestOptions&{includeAbsent?: boolean; deepCopy?: Function;}): Promise<Map<string, T|undefined>> {
        if (keys.length === 0)
            return Promise.resolve(new Map());
        let result: Map<string, T|undefined>|undefined;
        if (this.#itemsForPersistence) {
            let entries = keys
                .filter(key => this.#itemsForPersistence?.has(key))
                .map(key => [key, this.#itemsForPersistence?.get(key)!] as [string, T])
            if (entries.length > 0) {
                if (options?.deepCopy)
                    entries = entries.map(([key, value]) => [key, options.deepCopy!(value)]);
                result = new Map(entries);
            }
        }
        if (result) {
            keys = keys.filter(key => !result.has(key));
            if (keys.length === 0)
                return result;
        }
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const objectPromise = new Promise<Map<string, T|undefined>>((resolve, reject) => {
            const transaction = db.transaction([store], "readonly");
            transaction.onerror = evt => {
                reject(evt);
                db.close();
            };
            const abort = () => transaction.abort();
            const objectStore = transaction.objectStore(store);
            const results = new Map();
            let cnt = 0;
            for (const key of keys) {
                const dataRequest = objectStore.get(key)
                dataRequest.onerror = reject;
                dataRequest.onsuccess =  evt => {
                    const result = dataRequest.result;
                    if (result !== undefined || options?.includeAbsent)
                        results.set(key, result);
                    cnt++;
                    if (cnt === keys.length) {
                        resolve(results);
                        db.close();
                        options?.signal?.removeEventListener("abort", abort);
                    }
                }; 
            }
            if (transaction.commit)
                transaction.commit();
        });
        const additionalEntries: Map<string, T|undefined> = await objectPromise;
        if (!result)
            return additionalEntries;
        additionalEntries.forEach((value, key) => result.set(key, value));
        return result;
    }

    async has(key: string, options?: CacheRequestOptions): Promise<boolean> {
        return this.get(key, options).then(r => r !== undefined);
    }

    async #getInternal(key: string, options?: CacheRequestOptions): Promise<T|undefined> {
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const objectPromise = new Promise<T|undefined>((resolve, reject) => {
            const transaction = db.transaction([store], "readonly");
            transaction.onerror = evt => {
                reject(evt);
                db.close();
            };
            const abort = () => transaction.abort();
            const objectStore = transaction.objectStore(store);
            const dataRequest = objectStore.get(key)
            dataRequest.onerror = reject;
            options?.signal?.addEventListener("abort", abort, {once: true});
            dataRequest.onsuccess = evt => {
                resolve((evt.target as any).result);
                db.close();
                options?.signal?.removeEventListener("abort", abort);
            };
            if (transaction.commit)
                transaction.commit();
        });
        return objectPromise;
    }

    async #persistInternal(items: IterableIterator<[string, T]>, options?: CacheRequestOptions): Promise<unknown> {
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const donePromise = new Promise((resolve, reject) => {
            const transaction = db.transaction([store], "readwrite");
            transaction.onerror = evt => {
                reject(evt);
                db.close();
            };
            const abort = () => transaction.abort();
            options?.signal?.addEventListener("abort", abort, {once: true});
            const objectStore = transaction.objectStore(store);
            let request = undefined;
            for (const [key, value] of items) {
                request = objectStore.put(value, key);
            }
            request!.onsuccess = evt => {
                resolve((evt.target as any).result);
                db.close();
                options?.signal?.removeEventListener("abort", abort);
            }
            if (transaction.commit)
                transaction.commit();
        });
        return donePromise;
    }

    async size(options?: CacheRequestOptions): Promise<number> {
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const donePromise = new Promise<number>((resolve, reject) => {
            const transaction = db.transaction([store], "readonly");
            const abort = () => transaction.abort();
            options?.signal?.addEventListener("abort", abort, {once: true});
            transaction.onerror = evt => {
                reject(evt);
                db.close();
            };
            const objectStore = transaction.objectStore(store);
            const countRequest = objectStore.count();
            countRequest.onerror = reject;
            countRequest.onsuccess = () => {
                const numItems = countRequest.result;
                resolve(numItems + (this.#itemsForPersistence?.size || 0));
                db.close();
                options?.signal?.removeEventListener("abort", abort);
            }
            if (transaction.commit)
                transaction.commit();
        });
        return donePromise;
    }

    set(key: string, value: T, options?: CacheRequestOptions&CacheWriteOptions&{persistence?: PersistenceOrchestrator; deepCopy?: Function;}): Promise<unknown> {
        if (this.#itemsForPersistence && !options?.persistImmediately) {
            this.#itemsForPersistence.set(key, options?.deepCopy ? options.deepCopy(value) : value);
            options?.persistence?.trigger();
            return Promise.resolve();
        } else {
            return this.#persistInternal([[key, value]][Symbol.iterator]() as IterableIterator<[string, T]>, options);
        }
    }

    setAll(entries: Map<string, T>, options?: CacheRequestOptions&CacheWriteOptions&{persistence?: PersistenceOrchestrator; deepCopy?: Function;}): Promise<unknown> {
        if (this.#itemsForPersistence && !options?.persistImmediately) {
            entries.forEach((value, key) => this.#itemsForPersistence!.set(key, options?.deepCopy ? options.deepCopy(value) : value));
            options?.persistence?.trigger();
            return Promise.resolve();
        } else {
            return this.#persistInternal(entries.entries(), options);
        }
    }

    async getAllKeys(options?: CacheRequestOptions): Promise<Array<string>> {
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const objectPromise = new Promise<Array<string>>((resolve, reject) => {
            const transaction = db.transaction([store], "readonly");
            transaction.onerror = evt => {
                reject(evt);
                db.close();
            };
            const abort = () => transaction.abort();
            const objectStore = transaction.objectStore(store);
            const dataRequest = objectStore.getAllKeys();
            dataRequest.onerror = reject;
            options?.signal?.addEventListener("abort", abort, {once: true});
            dataRequest.onsuccess = evt => {
                const allKeys: Array<string> = (evt.target as any).result as any;
                if (this.#itemsForPersistence)
                    for (const key of this.#itemsForPersistence!.keys())
                        allKeys.push(key);
                resolve(allKeys);
                db.close();
                options?.signal?.removeEventListener("abort", abort);
            };
            if (transaction.commit)
                transaction.commit();
        });
        return objectPromise;
    }

    /**
     * @param keys 
     * @param options 
     * @returns 
     */
    async delete(keys: string|Array<string>, options?: CacheRequestOptions): Promise<number> {
        if (typeof(keys) === "string")
            keys = [keys];
        else
            keys = [...keys];
        let count = 0;
        if (this.#itemsForPersistence) {
            const removedKeys = keys
                .map(key => [key, this.#itemsForPersistence?.delete(key)] as [string, boolean])
                .filter(([key, removed]) => removed)
                .map(([key, removed]) => key);
            count = removedKeys.length;
            removedKeys.forEach(key => keys.splice(keys.indexOf(key, 1)));
        }
        if (keys.length === 0)
            return count;
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const deletePromise = new Promise<number>((resolve, reject) => {
            const transaction = db.transaction([store], "readwrite");
            transaction.onerror = evt => {
                reject(evt);
                db.close();
            };
            const abort = () => transaction.abort();
            options?.signal?.addEventListener("abort", abort, {once: true});
            const objectStore = transaction.objectStore(store);
            let request;
            for (const key of keys) {
                request = objectStore.delete(key);
            }
            request!.onsuccess = () => {
                resolve(keys.length + count);
                db.close();
                options?.signal?.removeEventListener("abort", reject);
            };
            if (transaction.commit)
                transaction.commit();
        });
        return deletePromise;
    }

    // @deprecated: use synchronized transaction instead
    async clear(options?: CacheRequestOptions): Promise<unknown> {
        const store = this.#objectStore;
        const db = await this.#dbLoader(options);
        const deletePromise = new Promise<unknown>((resolve, reject) => {
        const transaction = db.transaction([store], "readwrite");
        transaction.onerror = evt => {
            reject(evt);
            db.close();
        };
        const abort = () => transaction.abort();
        options?.signal?.addEventListener("abort", abort, {once: true});
        const objectStore = transaction.objectStore(store);
        const clearRequest = objectStore.clear();
        clearRequest.onerror = reject;
        clearRequest.onsuccess = () => {
                this.#itemsForPersistence?.clear();
                resolve(undefined);
                db.close();
                options?.signal?.removeEventListener("abort", reject);
            };
            if (transaction.commit)
                transaction.commit();
        });
        return deletePromise;
    }

    async close(): Promise<undefined> {
        if (this.#persistence)
            await this.#persistence!.close();
    }

    streamKeys(options?: {batchSize?: number; index?: string;}): ReadableStream<Array<string>> {
        let indexKey: keyof T|undefined;
        if (options?.index) {
            const indexData: {key: string}&IDBIndexParameters|undefined = this.#indexes?.get(options.index);
            if (!indexData)
                throw new Error("Index not found: " + options.index);
            indexKey = indexData.key as any;
            (options as any).indexKey = indexKey;
        }
        let unpersisted: Array<string>|undefined = undefined;
        if (this.#itemsForPersistence) {
            let data: Array<[string, T]> = Array.from(this.#itemsForPersistence?.entries());
            if (indexKey) {
                // TODO support also descending mode
                data = data.sort(([key1, t1], [key2, t2]) => {
                    const v1 = t1[indexKey];
                    const v2 = t2[indexKey];
                    if (v1 === v2)
                        return 0;
                    if (v1 < v2)
                        return -1;
                    return 1;
                });
            }
            unpersisted = data.map(arr => arr[0]);
        }

        const source: UnderlyingDefaultSource<Array<string>> = new TableStream(
            this.#IDBKeyRange,
            this.#objectStore, 
            () => this.#dbLoader(), 
            unpersisted,
            options);
        return new ReadableStream(source);
    }

    keys(options?: IterationOptions&{index?: string}): AsyncIterableIterator<Array<string>> {
        return this[Symbol.asyncIterator](options);
    }

    [Symbol.asyncIterator](options?: {batchSize?: number; index?: string;}): AsyncIterableIterator<Array<string>> {
        // Get a lock on the stream:
        const reader: ReadableStreamDefaultReader<Array<string>> = this.streamKeys(options).getReader();
        return {
            async next() {
                try {
                    const result = await reader.read();
                    return result as any;
                } catch (e) {
                    reader.releaseLock();
                    //throw e;
                    return {done: true, value: e};  // correct?
                }
            },
            return() {
                reader.releaseLock();
                return Promise.resolve({done: true}) as any
            },
            [Symbol.asyncIterator]() {
                return this;
            }
        };
    }

    isPersisted(): boolean {
        return !(this.#itemsForPersistence?.size! > 0);
    }

}


class PersistenceExecution<T> implements IterableIterator<IDBRequest> {

    constructor(private readonly objectStore: IDBObjectStore, private readonly entries: IterableIterator<[string, T]>) {
    }

    [Symbol.iterator](): IterableIterator<IDBRequest<any>> {
        return this;
    }

    next(...args: [] | [undefined]): IteratorResult<IDBRequest<any>, any> {
        const nextEntry = this.entries.next(...args);
        if (nextEntry.done)
            return {done: true, value: undefined};
        const [key, value] = nextEntry.value;
        return {done: false, value: this.objectStore.put(value, key)};
    }

    return?(value?: any): IteratorResult<IDBRequest<any>, any> {
        if (this.entries.return) 
            this.entries.return(value);
        return {done: true, value: value};  // ?
    }

    throw?(e?: any): IteratorResult<IDBRequest<any>, any> {
        if (this.entries.throw)
             this.entries.throw(e);
        return {done: true, value: e};    // ? 
    }

}


class DeletionExecution<T> implements IterableIterator<IDBRequest> {

    constructor(
        private readonly objectStore: IDBObjectStore, 
        private readonly keys: IterableIterator<string>,
        private readonly itemsForPersistence: Map<string, T>|undefined
        ) {
    }

    [Symbol.iterator](): IterableIterator<IDBRequest<any>> {
        return this;
    }

    next(...args: [] | [undefined]): IteratorResult<IDBRequest<any>, any> {
        const nextEntry = this.keys.next(...args);
        if (nextEntry.done)
            return {done: true, value: undefined};
        const key = nextEntry.value;
        this.itemsForPersistence?.delete(key);
        return {done: false, value: this.objectStore.delete(key)};
    }

    return?(value?: any): IteratorResult<IDBRequest<any>, any> {
        if (this.keys.return) 
            this.keys.return(value);
        return {done: true, value: value};  // ?
    }

    throw?(e?: any): IteratorResult<IDBRequest<any>, any> {
        if (this.keys.throw)
             this.keys.throw(e);
        return {done: true, value: e};    // ? 
    }

}

class ImmediatePersistenceExecution<T> implements IterableIterator<IDBRequest> {

    constructor(
        private readonly objectStore: IDBObjectStore, 
        private readonly entries: IterableIterator<[string, T]>,
        private readonly itemsForPersistence: Map<string, T>|undefined
        ) {
    }

    [Symbol.iterator](): IterableIterator<IDBRequest<any>> {
        return this;
    }

    next(...args: [] | [undefined]): IteratorResult<IDBRequest<any>, any> {
        const nextEntry = this.entries.next(...args);
        if (nextEntry.done)
            return {done: true, value: undefined};
        const [key, value] = nextEntry.value;
        this.itemsForPersistence?.delete(key);
        return {done: false, value: this.objectStore.put(value, key)};
    }

    return?(value?: any): IteratorResult<IDBRequest<any>, any> {
        if (this.entries.return) 
            this.entries.return(value);
        return {done: true, value: value};  // ?
    }

    throw?(e?: any): IteratorResult<IDBRequest<any>, any> {
        if (this.entries.throw)
             this.entries.throw(e);
        return {done: true, value: e};    // ? 
    }

}
