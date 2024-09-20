import { CacheRequestOptions } from "../cache.js";
import { PeriodicTask } from "./PeriodicTask.js";
import { PersistenceTask, Table, TransactionContext, TransactionOperation } from "./Table.js";

export class PersistenceOrchestrator {

    readonly #tasks: Array<PersistenceTask>;
    readonly #dbLoader: (options?: CacheRequestOptions) => Promise<IDBDatabase>;
    readonly #persistence: PeriodicTask;
    readonly #controller = new AbortController();

    constructor(tasks: Array<PersistenceTask>, persistencePeriod: number, dbLoader: (options?: CacheRequestOptions) => Promise<IDBDatabase>) {
        if (!(persistencePeriod > 0))
            throw new Error("Persistence period must be positive, got " + persistencePeriod);
        if (tasks.length === 0)
            throw new Error("No tasks provieded");
        this.#tasks = tasks;
        this.#dbLoader = dbLoader;
        this.#persistence = new PeriodicTask("LruIdbPersistence", persistencePeriod, () => this.#runPersistence());
    }

    trigger() {
        this.#persistence.trigger();
    }

    async #runPersistence() {
        const signal = this.#controller.signal;
        if (signal.aborted)
            return;
        const tasks = this.#tasks.filter(task => !task.empty());
        if (tasks.length === 0)
            return; 
        const db = await this.#dbLoader();
        const objectStores = tasks.map(t => t.objectStore());
        const contexts: Map<PersistenceTask, ContextContainer> = new Map(tasks.map(t => [t, new ContextContainer()]));
        const done = new Promise((resolve, reject) => {
            const transaction = db.transaction(objectStores, "readwrite");
            const abort = () => {
                try {
                    transaction.abort();
                } catch (_) {}
            };
            signal.addEventListener("abort", abort!, {once: true});
            const failed = (evt: Event|Error) => {
                reject(evt);
                db.close();
                signal.removeEventListener("abort", abort!);    
            }
            transaction.onerror = failed;
            let request: IDBRequest|undefined = undefined;
            for (const task of tasks) {
                const objectStore = transaction.objectStore(task.objectStore());
                for (const req of task.run(objectStore, contexts.get(task)!)!) {
                    req.onerror = failed;
                    request = req;
                }
            }
            if (!request) {
                failed(new Error("Transaction empty"));
                return;
            }
            request.onsuccess = evt => {
                resolve((evt.target as any).result);
                db.close();
                signal.removeEventListener("abort", abort!);    
            };
            if (transaction.commit)
                transaction.commit();
        });
        tasks.forEach(task => task.transactionCompleted(done, contexts.get(task)?.getContext()));
        return done;
    }

    close() {
        this.#persistence.close({runTask: true});
        this.#controller.abort(new Error("Persistence closed"));
    }

    public static delete(tables: Array<Table<any>>, keys: Array<string>, db: IDBDatabase, options?: CacheRequestOptions): Promise<unknown> {
        const signal = options?.signal;
        const objectStores = tables.map(t => t.objectStore());
        const done = new Promise((resolve, reject) => {
            const transaction = db.transaction(objectStores, "readwrite");
            const abort = () => {
                try {
                    transaction.abort();
                } catch (_) {}
            };
            signal?.addEventListener("abort", abort!, {once: true});
            const failed = (evt: Event|Error) => {
                reject(evt);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            }
            transaction.onerror = failed;
            let request: IDBRequest|undefined = undefined;
            for (const table of tables) {
                const deleteTask: TransactionOperation<Array<string>> = table.getDeletionTask();
                const objectStore = transaction.objectStore(table.objectStore());
                for (const req of deleteTask.execute(objectStore, keys)) {
                    //req.onerror = failed; // if a key is not present it is ok not to be deleted
                    request = req;
                }
            }
            if (!request) {
                failed(new Error("Transaction empty"));
                return;
            }
            request.onsuccess = evt => {
                resolve((evt.target as any).result);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            };
            if (transaction.commit)
                transaction.commit();
        });
        return done;
    } 

    public static persistImmediately(entries: Map<Table<any>, Map<string, any>>, db: IDBDatabase, options?: CacheRequestOptions): Promise<unknown> {
        const signal = options?.signal;
        const objectStores = Array.from(entries.keys()).map(table => table.objectStore());
        const done = new Promise((resolve, reject) => {
            const transaction = db.transaction(objectStores, "readwrite");
            const abort = () => {
                try {
                    transaction.abort();
                } catch (_) {}
            };
            signal?.addEventListener("abort", abort!, {once: true});
            const failed = (evt: Event|Error) => {
                reject(evt);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            }
            transaction.onerror = failed;
            let request: IDBRequest|undefined = undefined;
            for (const [table, entry] of entries.entries()) {
                const objectStore = transaction.objectStore(table.objectStore());
                const task = table.getImmediatePersistenceTask();
                for (const req of task.execute(objectStore, entry)) {
                    req.onerror = failed;
                    request = req;
                }
            }
            if (!request) {
                failed(new Error("Transaction empty"));
                return;
            }
            request.onsuccess = evt => {
                resolve((evt.target as any).result);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            };
            if (transaction.commit)
                transaction.commit();
        });
        return done;
    } 

    /**
     * 
     * @param tables 
     * @param db 
     * @param options 
     * @returns 
     */
    static async persistedSizes(tables: Array<Table<any>>, db: IDBDatabase, options?: CacheRequestOptions): Promise<Array<number>> {
        const stores = tables.map(t => t.objectStore());
        const signal = options?.signal;
        const donePromise = new Promise<Array<number>>((resolve, reject) => {
            const transaction = db.transaction(stores, "readonly");
            const abort = () => {
                try {
                    transaction.abort();
                } catch (_) {}
            };
            signal?.addEventListener("abort", abort!, {once: true});
            const failed = (evt: Event|Error) => {
                reject(evt);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            }
            transaction.onerror = failed;
            const results: Array<number|undefined> = new Array(tables.length).fill(undefined);
            tables.forEach((t, idx) => {
                const store = transaction.objectStore(t.objectStore());
                const request = store.count();
                request.onerror = failed;
                request.onsuccess = () => results[idx] = request.result;
                if (results.filter(r => r !== undefined).length === tables.length) {
                    resolve(results as Array<number>);
                    db.close();
                    signal?.removeEventListener("abort", abort);
                }
            });
            if (transaction.commit)
                transaction.commit();
        });
        const counts = await donePromise;
        return counts;
    }

    public static clear(tables: Array<Table<any>>, db: IDBDatabase, options?: CacheRequestOptions): Promise<unknown> {
        const signal = options?.signal;
        const objectStores = tables.map(t => t.objectStore());
        const done = new Promise((resolve, reject) => {
            const transaction = db.transaction(objectStores, "readwrite");
            const abort = () => {
                try {
                    transaction.abort();
                } catch (_) {}
            };
            signal?.addEventListener("abort", abort!, {once: true});
            const failed = (evt: Event|Error) => {
                reject(evt);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            }
            transaction.onerror = failed;
            let request: IDBRequest|undefined = undefined;
            for (const table of tables) {
                const clearTask: TransactionOperation<void> = table.getClearTask();
                const objectStore = transaction.objectStore(table.objectStore());
                for (const req of clearTask.execute(objectStore)) {
                    req.onerror = failed;
                    request = req;
                }
            }
            if (!request) {
                failed(new Error("Transaction empty"));
                return;
            }
            request.onsuccess = evt => {
                resolve((evt.target as any).result);
                db.close();
                signal?.removeEventListener("abort", abort!);    
            };
            if (transaction.commit)
                transaction.commit();
        });
        return done;
    } 

}

class ContextContainer implements TransactionContext {

    #ctx: any;

    setContext(ctx: any): void {
        this.#ctx = ctx;
    }

    getContext(): any {
        return this.#ctx;
    }

}