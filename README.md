# lru-cache-idb

A least-recently-used (LRU) cache for web applications based on IndexedDB.

## Introduction

[IndexedDB](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API) providing in-browser persistence for web applications is an obvious tool for use as a cache. On the other hand, using browser storage for caching leads to specific challenges, such as the fact that multiple instances of a web site (open in multiple tabs, for instance) all access the same storage.

Design:

* *Batched updates*: every read operation on an LRU cache leads to modifications in the stored data, and hence to a write operation. Since a cache may be read very often it is important to provide cheap reads, and hence to avoid writing to persistence on every invocation. In order to minimize the actual writes to IndexedDB, this library batches writes and only persists them periodically (default: every 15s). As a downside, this can lead to data loss if the application is closed in the meantime, or if the same page open in another tab evicts old data.
* *Batched deletes*: data eviction by default is also performed in batches running at most once per specified time interval, 1 minute by default. In the meantime, the cache may grow beyond its specified capacity. 
* *Memory layer*: besides the data stored in IndexedDB it is possible to configure an additional memory cache, typically retaining a subset of cached items in memory.
* *Dependency-free*: no third-party Javascript libraries used.
* *Modern Javascript*: implemented in Typescript as an ESM module.

## Getting started

Install: `npm install lru-cache-idb`

Basic usage:

```javascript
import { createCacheIdb } from "lru-cache-idb";

const cache = createCacheIdb({maxItems: 1000, memoryConfig: {maxItemsInMemory: 100}});
await cache.set("entry1", {a: 1, description: "The first entry"});
await cache.set("entry2", {a: 2, description: "The 2nd entry"});
const obj = await cache.get("entry1");
console.log("Object found:", obj);
```

It is possible to instantiate multiple caches on one page, but the database names must differ:

```javascript
const cache = createCacheIdb({database: "MySpecialDb", maxItems: 1000, memoryConfig: {maxItemsInMemory: 100}});
```

This is the database name in IndexedDB, the default being "LruIdbItemsCache". The existing databases/caches on a page can be viewed in the browser developer console, e.g. under Web Storage->Indexed DB (Firefox) or Application->Storage->IndexedDB (Chrome).

## Develop

After cloning the repository, install the dev dependencies: `npm install`.

### Build

```
npm run build
```

### Demo app

This repository contains a sample HTML file *index.html* using the library. For instance, start a dev server using `npx http-server`, then the page will be available in the browser at http://localhost:8080 (check port in console output). Build first, index.html refers to the compiled Javascript files in the *dist/* folder.

### Tests

Tests run in NodeJS and hence cannot access an actual browser's IndexedDB implementation. Instead, they run against [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB).
To run all tests, build first, then:

```
npm run test
```

To run tests in a single file:

```
npx ava ./test/testDefaultCache.js
```

In order to run a single test in a single file, replace `test("...", async t => {` at the beginning of the test by `test.only("...", async t => {`.
