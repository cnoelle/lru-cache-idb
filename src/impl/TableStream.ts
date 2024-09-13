import { queryIdbSingle } from "./Utils.js";

export class TableStream implements UnderlyingDefaultSource<Array<string>> {

    readonly #IDBKeyRange: any;
    readonly #objectStore: string;
    readonly #batchSize: number;
    readonly #index?: string;
    readonly #indexKey?: string;
    readonly #unpersistedItems?: Array<string>;
    readonly #openDb: () => Promise<IDBDatabase>;
    // state
    #lastKey: string|undefined = undefined;
    #lastValue: any|undefined = undefined; // only relevant if searching according to an index
    #previousBatch: Array<string>|undefined;
    #batchSizeCorrection: number = 0;
    #canceled: boolean = false;


    constructor(IDBKeyRange: any, objectStore: string, openDb: () => Promise<IDBDatabase>, unpersistedItems?: Array<string>, 
                options?: {batchSize?: number; index?: string; indexKey?: string;}) {
        if (options?.batchSize !== undefined && (options?.batchSize! <= 0 || !Number.isInteger(options.batchSize)))
            throw new Error("Batch size must be a positive integer, got " + options?.batchSize);
        this.#IDBKeyRange = IDBKeyRange;
        this.#objectStore = objectStore;
        this.#openDb = openDb;
        this.#batchSize = options?.batchSize || 100;
        this.#unpersistedItems = unpersistedItems;
        this.#index = options?.index;
        this.#indexKey = options?.indexKey;
        if (this.#index && !this.#indexKey)
            throw new Error("Need to specify an index key if using an index for iteration");
    }

    async pull(controller: ReadableStreamDefaultController<Array<string>>): Promise<void> {
        if (this.#canceled) {
            controller.close();
            return;
        }
        try {
            const store = this.#objectStore;
            const db = await this.#openDb();
            const useOpenBoundary: boolean = this.#index === undefined;
            const objectPromise = new Promise<Array<string>|undefined>((resolve, reject) => {
                if (this.#canceled || controller.desiredSize! <= 0 ) { 
                    resolve(undefined); // XXX 
                    return;
                }
                const transaction = db.transaction([store], "readonly");
                transaction.onerror = reject;
                const objectStore = transaction.objectStore(store);
                // we'd like to exclude the lower bound here, but since the access time is not necessarily unique we must include it
                const query = this.#lastValue !== undefined ? this.#IDBKeyRange.lowerBound(this.#lastValue, useOpenBoundary)  : undefined;
                const base = this.#index ? objectStore.index(this.#index) : objectStore;
                const dataRequest = base.getAllKeys(query, this.#batchSize + this.#batchSizeCorrection);
                dataRequest.onerror = reject;
                dataRequest.onsuccess = evt => {
                    let allKeys: Array<string> = (evt.target as any).result;
                    resolve(allKeys);
                };
                if (transaction.commit)
                    transaction.commit();
            });
            let keys = await objectPromise;
            const previous =  this.#previousBatch;
            this.#previousBatch = !useOpenBoundary ? keys : undefined;
            if (!keys || this.#canceled)
                return;
            if (!useOpenBoundary && previous) {
                let start = 0;
                for (start=0; start<keys.length; start++) {
                    if (previous.indexOf(keys[start]) < 0)
                        break;
                }
                if (start > 0) {
                    if (start === keys.length) {
                        // otherwise we'll get empty keys and are done
                        if (keys.length === this.#batchSize + this.#batchSizeCorrection) {
                            // this is a pathological case that all elements in the batch have the same index value, due the need to include the lower bound in the query
                            this.#batchSizeCorrection += this.#batchSize;  // duplicate batch size in the next iteration
                            return this.pull(controller);
                        }
                    }
                    keys = keys.slice(start)

                }
            }
            if (keys.length === 0) {
                const unpersisted = this.#unpersistedItems;
                if (unpersisted?.length! > 0) // may lead to wrong order, though, due to races
                    controller.enqueue(unpersisted);
                controller.close();
                return;
            }
            this.#lastKey = keys[keys.length-1];
            if (this.#index)
                this.#lastValue = await this.#getLastKeyValue(this.#lastKey);
            else
                this.#lastValue = this.#lastKey;
            if (this.#unpersistedItems) {
                // avoid duplications...
                keys = keys.filter(k => this.#unpersistedItems!.indexOf(k) < 0);
                // we might also want to avoid ordering issues here; but since we do not know 
                // where exactly the unpersisted items fit, there may be some incorrect ordering between persisted and non-persisted items in special cases.
            }
            controller.enqueue(keys);
        } catch (e) {
            controller.error(e); 
        }
    }

    async #getLastKeyValue(key: string): Promise<any> {
        const store = this.#objectStore;
        const db = await this.#openDb();
        const value = await queryIdbSingle(db, store, "readonly", base => base.get(key));
        const indexValue = value[this.#indexKey!];
        return indexValue;
    }

    cancel(reason?: any) {
        this.#canceled = true;
    }

}