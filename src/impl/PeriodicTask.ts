import { Milliseconds } from "../cache.js";

/**
 * A task that is run at most every x milliseconds, if triggered externally
 */
export class PeriodicTask {

    readonly #id: string;
    readonly #task: () => Promise<unknown>;
    readonly #period: Milliseconds;
    
    // state
    #taskActive: boolean = false;
    #taskRequested: boolean = false;
    #taskTimer: number|undefined;

    readonly #syncedTask = async () => {
        if (this.#taskActive)
            return;
        globalThis.clearTimeout(this.#taskTimer);
        this.#taskTimer = undefined;
        this.#taskActive = true;
        try {
            await this.#task();
        }catch (e) { // TODO define error handler
            console.log("Task", this.#id, "failed(?)", e);
            this.#taskActive = false;
            this.trigger(); // TODO with backoff?
        } finally {
            this.#taskActive = false;
            this.#checkRetrigger();
        }

    };

    constructor(id: string, period: Milliseconds, task: () => Promise<unknown>, options?: {initialDelay?: Milliseconds}) {
        if (!(period > 0))
            throw new Error("period argument must be a positive number");
        this.#id = id;
        this.#period = period;
        this.#task = task;
    }

    trigger(): void {
        if (this.#taskTimer !== undefined)
            return;
        if (this.#taskActive) {
            this.#taskRequested = true;
            return;
        }
        this.#taskTimer = globalThis.setTimeout(() => this.#syncedTask(), this.#period);
    }

    triggerImmediate(): Promise<unknown> {
        return this.#syncedTask();
    }

    async close(options?: {runTask?: boolean}): Promise<unknown> {
        if (options?.runTask)
            await this.#syncedTask();
        this.#taskRequested = false;
        this.#taskActive = true;
        globalThis.clearTimeout(this.#taskTimer);
        return undefined;
    }

    #checkRetrigger(): void {
        if (this.#taskRequested) {
            this.#taskRequested = false;
            this.trigger();
        }
    }

}