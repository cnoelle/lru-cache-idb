import test from "ava";
import fakeIndexedDB, {IDBKeyRange} from "fake-indexeddb";
import { createCacheIdb } from "../dist/cache.js";

let cnt = 0;

function createFakeIdb(options) {
    options = {
        databaseName: "TestMemory" + cnt++, 
        ...options, 
        indexedDB: {
            databaseFactory: fakeIndexedDB,
            keyRange: IDBKeyRange
        }
    };
    return createCacheIdb(options);
}

async function waitForClock() {
    const start = Date.now();
    let end = start;
    while (end <= start) {
        await new Promise(resolve => setTimeout(resolve, 1));
        end = Date.now();
    }
}

// mostly validating the test setup
test("Memory cache can be created and closed", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }});
    t.truthy(defaultCache);
    await defaultCache.close();
});

test("Empty memory cache works", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }});
    const allKeys = await defaultCache.getAllKeys();
    t.is(allKeys.length, 0);
    t.is(await defaultCache.size(), 0);
    await defaultCache.clear();
    for await (const key of defaultCache) {
        t.fail("Cache should not have any entries");
    }
    await defaultCache.close();
});

test("Retrieving a non-existent value works with memory cache", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }});
    const result = await defaultCache.get("test");
    t.is(result, undefined);
    await defaultCache.close();
});

test("set() works for memory cache", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    const allKeys = await defaultCache.getAllKeys();
    t.is(allKeys.length, 1);
    t.is(await defaultCache.size(), 1);
    await defaultCache.set(obj2.a, obj2);
    const allKeys2 = await defaultCache.getAllKeys();
    t.is(allKeys2.length, 2);
    t.is(await defaultCache.size(), 2);
    t.is((await defaultCache.getAll([obj1, obj2].map(o => o.a))).size, 2);
    let idx = 0;
    for await (const keysBatch of defaultCache) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj1 : obj2;
            t.is(key, expected.a);
            const obj = await defaultCache.get(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    await defaultCache.close();
});

test("set() works for memory cache with immediate persistence", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }, persistencePeriod: 0});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    const allKeys = await defaultCache.getAllKeys();
    t.is(allKeys.length, 1);
    t.is(await defaultCache.size(), 1);
    await defaultCache.set(obj2.a, obj2);
    const allKeys2 = await defaultCache.getAllKeys();
    t.is(allKeys2.length, 2);
    t.is(await defaultCache.size(), 2);
    t.is((await defaultCache.getAll([obj1, obj2].map(o => o.a))).size, 2);
    let idx = 0;
    // passes, but only because all keys fit into the first batch. Then an error is thrown by fake-indexedd, likely a bug
    for await (const keysBatch of defaultCache) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj1 : obj2;
            t.is(key, expected.a);
            const obj = await defaultCache.get(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    await defaultCache.close();
});

// in the following tests the memory capacity is lower than the number of items added
test("set() works for memory cache with low capacity", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 1 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    const allKeys = await defaultCache.getAllKeys();
    t.is(allKeys.length, 1);
    t.is(await defaultCache.size(), 1);
    await defaultCache.set(obj2.a, obj2);
    const allKeys2 = await defaultCache.getAllKeys();
    t.is(allKeys2.length, 2);
    t.is(await defaultCache.size(), 2);
    t.is((await defaultCache.getAll([obj1, obj2].map(o => o.a))).size, 2);
    let idx = 0;
    for await (const keysBatch of defaultCache) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj1 : obj2;
            t.is(key, expected.a);
            const obj = await defaultCache.get(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    await defaultCache.close();
});

test("set() works for memory cache with immediate persistence and low capacity", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 1 }, persistencePeriod: 0});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    const allKeys = await defaultCache.getAllKeys();
    t.is(allKeys.length, 1);
    t.is(await defaultCache.size(), 1);
    await defaultCache.set(obj2.a, obj2);
    const allKeys2 = await defaultCache.getAllKeys();
    t.is(allKeys2.length, 2);
    t.is(await defaultCache.size(), 2);
    t.is((await defaultCache.getAll([obj1, obj2].map(o => o.a))).size, 2);
    let idx = 0;
    // passes, but only because all keys fit into the first batch. Then an error is thrown by fake-indexedd, likely a bug
    for await (const keysBatch of defaultCache) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj1 : obj2;
            t.is(key, expected.a);
            const obj = await defaultCache.get(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    await defaultCache.close();
});


test("iteration according to last usage works for memory cache", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    await defaultCache.set(obj2.a, obj2);
    await waitForClock();
    t.deepEqual(await defaultCache.get(obj1.a), obj1);

    let idx = 0;
    for await (const keysBatch of defaultCache[Symbol.asyncIterator]({orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj2 : obj1;  // in reverse order!
            t.is(key, expected.a);
            const obj = await defaultCache.get(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    t.is(idx, 2);
    await defaultCache.close();
});

test("iteration according to last usage works for memory cache and immediate persistence", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 1 }, persistencePeriod: 0});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    await defaultCache.set(obj2.a, obj2);
    await waitForClock();
    t.deepEqual(await defaultCache.get(obj1.a), obj1);

    let idx = 0;
    for await (const keysBatch of defaultCache[Symbol.asyncIterator]({orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj2 : obj1;  // in reverse order!
            t.is(key, expected.a);
            const obj = await defaultCache.get(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    t.is(idx, 2);
    await defaultCache.close();
});

test("iteration with small batch size works for memory cache", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }, maxItems: 10});
    const objects = new Map(new Array(4).fill(undefined).map((_, idx) => ["test" + idx, {a: "test" + idx, b: idx}]));
    await defaultCache.setAll(objects);
    const keysSeens = [];
    for await (const keysBatch of defaultCache.keys({batchSize: 2, orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            keysSeens.push(key);
        }
    }
    t.is(keysSeens.length, objects.size);
    await defaultCache.close();
});

test("iteration with small batch size works for memory cache and immediate persistence", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }, maxItems: 10, persistencePeriod: 0});
    const objects = new Map(new Array(4).fill(undefined).map((_, idx) => ["test" + idx, {a: "test" + idx, b: idx}]));
    await defaultCache.setAll(objects);
    const keysSeens = [];
    for await (const keysBatch of defaultCache.keys({batchSize: 2})) {
        for (const key of keysBatch) {
            keysSeens.push(key);
        }
    }
    t.is(keysSeens.length, objects.size);
    await defaultCache.close();
});

test("iteration with small batch size works for memory cache and immediate persistence in time ordering", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 5 }, maxItems: 10, persistencePeriod: 0});
    const objects = new Map(new Array(4).fill(undefined).map((_, idx) => ["test" + idx, {a: "test" + idx, b: idx}]));
    await defaultCache.setAll(objects);
    const keysSeens = [];
    for await (const keysBatch of defaultCache.keys({batchSize: 2, orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            keysSeens.push(key);
        }
    }
    t.is(keysSeens.length, objects.size);
    await defaultCache.close();
});


/**
 * ============================
 * Delete and clean up tests
 * ============================
 */


test("delete() works for memory cache", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    await defaultCache.set(obj1.a, obj1);
    await defaultCache.delete(obj1.a);
    t.is(await defaultCache.size(), 0)
    t.falsy(await defaultCache.get(obj1.a));
    await defaultCache.close();
});

test("delete() works for memory cache with immediate persistence", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    await defaultCache.set(obj1.a, obj1);
    await defaultCache.delete(obj1.a);
    t.is(await defaultCache.size(), 0)
    t.falsy(await defaultCache.get(obj1.a));
    await defaultCache.close();
});

test("old data is eventually purged with memory cache", async t => {
    const cleanUpPeriod = 50;
    const numItems = 4;
    const defaultCache = createFakeIdb({maxItems: numItems, numItemsToPurge: 2, evictionPeriod: cleanUpPeriod, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "first", b: -1};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    const objects = new Map(new Array(4).fill(undefined).map((_, idx) => ["test" + idx, {a: "test" + idx, b: idx}]));
    await defaultCache.setAll(objects);
    // now there are more elements in the cache than the specified capacity
    for (let idx=0; idx<20; idx++) { // TODO 20
        await new Promise(resolve => setTimeout(resolve, cleanUpPeriod));
        if (await defaultCache.size() < numItems)
            break;
    }
    t.assert(await defaultCache.size() < numItems);
    // the oldest one must be purged in any case
    t.falsy(await defaultCache.get(obj1.a)); 
    await defaultCache.close();
});

test("old data is eventually purged with memory cache and immediate persistence", async t => {
    const cleanUpPeriod = 50;
    const numItems = 4;
    const defaultCache = createFakeIdb({maxItems: numItems, numItemsToPurge: 2, evictionPeriod: cleanUpPeriod, persistencePeriod: 0, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "first", b: -1};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    const objects = new Map(new Array(4).fill(undefined).map((_, idx) => ["test" + idx, {a: "test" + idx, b: idx}]));
    await defaultCache.setAll(objects);
    // now there are more elements in the cache than the specified capacity
    for (let idx=0; idx<20; idx++) { // TODO 20
        await new Promise(resolve => setTimeout(resolve, cleanUpPeriod));
        if (await defaultCache.size() < numItems)
            break;
    }
    t.assert(await defaultCache.size() < numItems);
    // the oldest one must be purged in any case
    t.falsy(await defaultCache.get(obj1.a)); 
    await defaultCache.close();
});


test("peek does not affect access times for memory cache", async t => {
    const defaultCache = createFakeIdb({memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    await defaultCache.set(obj2.a, obj2);
    await waitForClock();
    t.deepEqual(await defaultCache.peek(obj1.a), obj1);

    let idx = 0;
    for await (const keysBatch of defaultCache.keys({orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj1 : obj2;  // in original order, peek should not affect this
            t.is(key, expected.a);
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    t.is(idx, 2);
    await defaultCache.close();
});

test("peek does not affect access times for default cache and immediate persistence", async t => {
    const defaultCache = createFakeIdb({persistencePeriod: 0, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    await defaultCache.set(obj2.a, obj2);
    await waitForClock();
    t.deepEqual(await defaultCache.peek(obj1.a), obj1);

    let idx = 0;
    for await (const keysBatch of defaultCache[Symbol.asyncIterator]({orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            const expected = idx === 0 ? obj1 : obj2;  // in original order, peek should not affect this
            t.is(key, expected.a);
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    t.is(idx, 2);
    await defaultCache.close();
});

test("Order of items works with in-memory updates in memory cache", async t => {
    const persistencePeriod = 50;
    const defaultCache = createFakeIdb({persistencePeriod: persistencePeriod, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    const obj3 = {a: "test3", b: 3};
    await defaultCache.set(obj1.a, obj1);
    await waitForClock();
    await defaultCache.set(obj2.a, obj2);
    await waitForClock();
    // swap the items
    await defaultCache.get(obj1.a);
    await waitForClock();
    await defaultCache.set(obj3.a, obj3);
    const expectedObjects = [obj2, obj1, obj3];
    let idx = 0;
    for await (const keysBatch of defaultCache.keys({orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            const expected = expectedObjects[idx];
            t.is(key, expected.a);
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    while (!defaultCache.__isPersisted__()) {
        await new Promise(resolve => setTimeout(resolve, persistencePeriod/2));
    }
    // try again, this time with persisted items
    idx = 0;
    for await (const keysBatch of defaultCache.keys({orderByAccessTime: "asc"})) {
        for (const key of keysBatch) {
            const expected = expectedObjects[idx];
            t.is(key, expected.a);
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    await defaultCache.close();
});


test("copyOnInsert works with in-memory cache", async t => {
    const cache = createFakeIdb({persistencePeriod: 5_000, copyOnInsert: true, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const copy = {...obj1};
    await cache.set(obj1.a, obj1);
    obj1.b = 2;
    t.deepEqual(await cache.get(obj1.a), copy);
    await cache.close();
});

test("copyOnInsert works with in-memory cache with setAll", async t => {
    const cache = createFakeIdb({persistencePeriod: 5_000, copyOnInsert: true, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    const copy1 = {...obj1};
    const copy2 = {...obj2};
    await cache.setAll(new Map([[obj1.a, obj1], [obj2.a, obj2]]));
    obj1.b = -1;
    obj2.b = -2;
    t.deepEqual(await cache.get(obj1.a), copy1);
    t.deepEqual(await cache.get(obj2.a), copy2);
    await cache.close();
});

test("copyOnInsert works with in-memory cache with immediate persistence", async t => {
    const cache = createFakeIdb({persistencePeriod: 0, copyOnInsert: true, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const copy = {...obj1};
    await cache.set(obj1.a, obj1);
    obj1.b = 2;
    t.deepEqual(await cache.get(obj1.a), copy);
    await cache.close();
});


test("copyOnReturn works with in-memory cache", async t => {
    const cache = createFakeIdb({persistencePeriod: 5_000, copyOnReturn: true, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const copy = {...obj1};
    await cache.set(obj1.a, obj1);
    (await cache.get(obj1.a)).b = 2;
    t.deepEqual(await cache.get(obj1.a), copy);
    await cache.close();
});

test("copyOnReturn works with in-memory cache with getAll", async t => {
    const cache = createFakeIdb({persistencePeriod: 5_000, copyOnReturn: true, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    const copy1 = {...obj1};
    const copy2 = {...obj2};
    await cache.set(obj1.a, obj1);
    await cache.set(obj2.a, obj2);
    (await cache.get(obj1.a)).b = -1;
    (await cache.get(obj2.a)).b = -2;
    t.deepEqual(await cache.get(obj1.a), copy1);
    t.deepEqual(await cache.get(obj2.a), copy2);
    await cache.close();
});

test("copyOnReturn works with in-memory cache with immediate persistence", async t => {
    const cache = createFakeIdb({persistencePeriod: 0, copyOnReturn: true, memoryConfig: { maxItemsInMemory: 10 }});
    const obj1 = {a: "test1", b: 1};
    const copy = {...obj1};
    await cache.set(obj1.a, obj1);
    (await cache.get(obj1.a)).b = 2;
    t.deepEqual(await cache.get(obj1.a), copy);
    await cache.close();
});

