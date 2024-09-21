import test from "ava";
import fakeIndexedDB, {IDBKeyRange} from "fake-indexeddb";
import { createCacheIdb } from "../dist/cache.js";

let cnt = 0;

function createFakeIdb(options) {
    const dbName = options?.dbName || "Test" + cnt++;
    options = {
        databaseName: dbName, 
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
test("Default cache can be created and closed", async t => {
    const defaultCache = createFakeIdb();
    t.truthy(defaultCache);
    await defaultCache.close();
});

test("Empty default cache works", async t => {
    const defaultCache = createFakeIdb();
    const allKeys = await defaultCache.getAllKeys();
    t.is(allKeys.length, 0);
    t.is(await defaultCache.size(), 0);
    await defaultCache.clear();
    for await (const key of defaultCache) {
        t.fail("Cache should not have any entries");
    }
    await defaultCache.close();
});

test("set() works for default cache", async t => {
    const defaultCache = createFakeIdb();
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

test("set() works for default cache with immediate persistence", async t => {
    const defaultCache = createFakeIdb({persistencePeriod: 0});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    t.true(defaultCache.__isPersisted__())
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
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    await defaultCache.close();
});

/**
 * ============================
 * keys iteration tests below
 * ============================
 */


test("iteration according to last usage works for default cache", async t => {
    const defaultCache = createFakeIdb({/*persistencePeriod: 0*/});
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
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    t.is(idx, 2);
    await defaultCache.close();
});

test("iteration according to last usage works for default cache and immediate persistence", async t => {
    const defaultCache = createFakeIdb({persistencePeriod: 0});
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
            const obj = await defaultCache.peek(key);
            t.deepEqual(obj, expected);
            idx++;
        }
    }
    t.is(idx, 2);
    await defaultCache.close();
});

test("iteration with small batch size works for default cache", async t => {
    const defaultCache = createFakeIdb({maxItems: 10});
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

test("iteration with small batch size works for default cache and immediate persistence", async t => {
    const defaultCache = createFakeIdb({maxItems: 10, persistencePeriod: 0});
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

test("iteration with small batch size works for default cache and immediate persistence in time ordering", async t => {
    const defaultCache = createFakeIdb({maxItems: 10, persistencePeriod: 0});
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
 * persistence tests
 * ============================
 */

test("data is eventually persisted", async t => {
    const persistencePeriod = 50;
    const defaultCache = createFakeIdb({persistencePeriod: persistencePeriod});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await defaultCache.set(obj1.a, obj1);
    await defaultCache.set(obj2.a, obj2);
    t.false(defaultCache.__isPersisted__());
    for (let idx=0; idx<20; idx++) {
        await new Promise(resolve => setTimeout(resolve, persistencePeriod));
        if (defaultCache.__isPersisted__())
            break;
    }
    t.true(defaultCache.__isPersisted__());
    t.is(await defaultCache.size(), 2);
    await defaultCache.close();
});

/**
 * ============================
 * Delete and clean up tests
 * ============================
 */


test("delete() works for default cache", async t => {
    const defaultCache = createFakeIdb();
    const obj1 = {a: "test1", b: 1};
    await defaultCache.set(obj1.a, obj1);
    await defaultCache.delete(obj1.a);
    t.is(await defaultCache.size(), 0)
    t.falsy(await defaultCache.get(obj1.a));
    await defaultCache.close();
});

test("delete() works for default cache with immediate persistence", async t => {
    const defaultCache = createFakeIdb({persistencePeriod: 0});
    const obj1 = {a: "test1", b: 1};
    await defaultCache.set(obj1.a, obj1);
    await defaultCache.delete(obj1.a);
    t.is(await defaultCache.size(), 0)
    t.falsy(await defaultCache.get(obj1.a));
    await defaultCache.close();
});

test("old data is eventually purged", async t => {
    const cleanUpPeriod = 50;
    const numItems = 4;
    const defaultCache = createFakeIdb({maxItems: numItems, numItemsToPurge: 2, evictionPeriod: cleanUpPeriod});
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

test("old data is eventually purged with immediate persistence", async t => {
    const cleanUpPeriod = 50;
    const numItems = 4;
    const defaultCache = createFakeIdb({maxItems: numItems, numItemsToPurge: 2, evictionPeriod: cleanUpPeriod, persistencePeriod: 0});
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


test("peek does not affect access times for default cache", async t => {
    const defaultCache = createFakeIdb({});
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
    const defaultCache = createFakeIdb({persistencePeriod: 0});
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

test("Order of items works with in-memory updates in default cache", async t => {
    const persistencePeriod = 50;
    const defaultCache = createFakeIdb({persistencePeriod: persistencePeriod});
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

// not possible without adding significantly more requests; but this might be acceptable.
test.skip("Order of items works with in-memory updates and immediately persisted items in default cache", async t => {
    const persistencePeriod = 50;
    const defaultCache = createFakeIdb({persistencePeriod: persistencePeriod});
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
    await defaultCache.set(obj3.a, obj3, {persistImmediately: true});
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

test("Multiple caches in the same db work in parallel", async t => {
    const dbName = "Test_conc1";
    const key = "a";
    const cache1 = createFakeIdb({dbName: dbName, tablePrefix: "A"});
    const cache2 = createFakeIdb({dbName: dbName, tablePrefix: "B"});
    await Promise.all([cache1.set(key, "test"), cache2.set(key, "test2")]);
    const [r1, r2] = await Promise.all([cache1.get(key), cache2.get(key)]);
    t.is(r1, "test");
    t.is(r2, "test2");
    await Promise.all([cache1.close(), cache2.close()]);
});

test("Multiple caches in the same db work in parallel with immediate persistence", async t => {
    const dbName = "Test_conc2";
    const key = "a";
    const cache1 = createFakeIdb({dbName: dbName, tablePrefix: "A", persistencePeriod: 0});
    const cache2 = createFakeIdb({dbName: dbName, tablePrefix: "B", persistencePeriod: 0});
    await Promise.all([cache1.set(key, "test"), cache2.set(key, "test2")]);
    const [r1, r2] = await Promise.all([cache1.get(key), cache2.get(key)]);
    t.is(r1, "test");
    t.is(r2, "test2");
    await Promise.all([cache1.close(), cache2.close()]);
});

test("Multiple caches in the same db work sequentially with immediate persistence", async t => {
    const dbName = "Test_conc3";
    const key = "a";
    const cache1 = createFakeIdb({dbName: dbName, tablePrefix: "A", persistencePeriod: 0});
    const cache2 = createFakeIdb({dbName: dbName, tablePrefix: "B", persistencePeriod: 0});
    await cache1.set(key, "test");
    await cache2.set(key, "test2");
    const [r1, r2] = await Promise.all([cache1.get(key), cache2.get(key)]);
    t.is(r1, "test");
    t.is(r2, "test2");
    await Promise.all([cache1.close(), cache2.close()]);
});

test("Many caches in the same db work sequentially with immediate persistence", async t => {
    const numTables = 10;
    const dbName = "Test_conc4";
    const key = "a";
    const caches = new Array(numTables).fill(undefined).map((_, idx) => createFakeIdb({dbName: dbName, tablePrefix: idx + "", persistencePeriod: 0}));
    let idx = 0;
    for (const cache of caches) {
        await cache.set(key, "test" + idx++);    
    }
    const results = await Promise.all(caches.map(cache => cache.get(key)));
    results.forEach((result, idx) => t.is(result, "test" + idx));
    await Promise.all(caches.map(cache => cache.close()));
});

test("Many caches in the same db work sequentially with immediate persistence with pre-allocated tables", async t => {
    const numTables = 10;
    const dbName = "Test_conc5";
    const key = "a";
    const tablePrefixes = new Array(numTables).fill(undefined).map((_, idx) => idx + "");
    const caches = new Array(numTables).fill(undefined).map((_, idx) => createFakeIdb({
        dbName: dbName, 
        tablePrefix: tablePrefixes[idx], 
        tablePrefixesUsed: tablePrefixes,
        persistencePeriod: 0
    }));
    let idx = 0;
    for (const cache of caches) {
        await cache.set(key, "test" + idx++);    
    }
    const results = await Promise.all(caches.map(cache => cache.get(key)));
    results.forEach((result, idx) => t.is(result, "test" + idx));
    await Promise.all(caches.map(cache => cache.close()));
});

test("Many caches in the same db work sequentially with immediate persistence with partly pre-allocated tables", async t => {
    const numTables = 10;
    const dbName = "Test_conc6";
    const key = "a";
    const tablePrefixes = new Array(numTables).fill(undefined).map((_, idx) => idx + "");
    const caches = new Array(numTables).fill(undefined).map((_, idx) => createFakeIdb({
        dbName: dbName, 
        tablePrefix: tablePrefixes[idx], 
        tablePrefixesUsed: tablePrefixes.slice(0, Math.round(numTables/2)),
        persistencePeriod: 0
    }));
    let idx = 0;
    for (const cache of caches) {
        await cache.set(key, "test" + idx++);    
    }
    const results = await Promise.all(caches.map(cache => cache.get(key)));
    results.forEach((result, idx) => t.is(result, "test" + idx));
    await Promise.all(caches.map(cache => cache.close()));
});

test("Many caches in the same db work in parallel with immediate persistence", async t => {
    const numTables = 10;
    const dbName = "Test_conc7";
    const key = "a";
    const caches = new Array(numTables).fill(undefined).map((_, idx) => createFakeIdb({dbName: dbName, tablePrefix: idx + "", persistencePeriod: 0}));
    await Promise.all(caches.map((cache, idx) => cache.set(key, "test" + idx)));
    const results = await Promise.all(caches.map(cache => cache.get(key)));
    results.forEach((result, idx) => t.is(result, "test" + idx));
    await Promise.all(caches.map(cache => cache.close()));
});

test("Multiple caches in different dbs work in parallel", async t => {
    const dbName = "Test_conc";
    const key = "a";
    const cache1 = createFakeIdb({dbName: dbName + "_a", tablePrefix: "A"});
    const cache2 = createFakeIdb({dbName: dbName + "_b", tablePrefix: "B"});
    await Promise.all([cache1.set(key, "test"), cache2.set(key, "test2")]);
    const [r1, r2] = await Promise.all([cache1.get(key), cache2.get(key)]);
    t.is(r1, "test");
    t.is(r2, "test2");

    await Promise.all([cache1.close(), cache2.close()]);
});

test("Many caches in different dbs work sequentially with immediate persistence", async t => {
    const numTables = 10;
    const key = "a";
    const caches = new Array(numTables).fill(undefined).map((_, idx) => createFakeIdb({tablePrefix: "A", persistencePeriod: 0}));
    let idx = 0;
    for (const cache of caches) {
        await cache.set(key, "test" + idx++);    
    }
    const results = await Promise.all(caches.map(cache => cache.get(key)));
    results.forEach((result, idx) => t.is(result, "test" + idx));
    await Promise.all(caches.map(cache => cache.close()));
});

test("Cache persistence works with immediate persistence", async t => {
    const dbName = "PersistenceTest1";
    const cache = createFakeIdb({dbName: dbName, persistencePeriod: 0});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await cache.set(obj1.a, obj1);
    await cache.set(obj2.a, obj2);
    t.is(await cache.size(), 2);
    await cache.close();
    const cache2 = createFakeIdb({dbName: dbName, persistencePeriod: 0});
    t.is(await cache.size(), 2);
    t.like(await cache2.getAllKeys(), [obj1.a, obj2.a]);
    await cache2.close();
});

test("Cache persistence works with explicit close", async t => {
    const dbName = "PersistenceTest2";
    const cache = createFakeIdb({dbName: dbName, persistencePeriod: 5_000});
    const obj1 = {a: "test1", b: 1};
    const obj2 = {a: "test2", b: 2};
    await cache.set(obj1.a, obj1);
    await cache.set(obj2.a, obj2);
    t.is(await cache.size(), 2);
    await cache.persist();
    await cache.close();  // the close call ensures that the persistence is triggered 
    const cache2 = createFakeIdb({dbName: dbName, persistencePeriod: 5_000});
    t.is(await cache.size(), 2);
    t.like(await cache2.getAllKeys(), [obj1.a, obj2.a]);
    await cache2.close();
});

