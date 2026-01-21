import { jest } from '@jest/globals';

/**
 * Creates a mock Discord.js Collection with common methods
 */
export function createMockCollection<K, V>(entries: [K, V][] = []): any {
  const map = new Map(entries);
  
  return {
    get: (key: K) => map.get(key),
    set: (key: K, value: V) => map.set(key, value),
    has: (key: K) => map.has(key),
    delete: (key: K) => map.delete(key),
    clear: () => map.clear(),
    forEach: (fn: (value: V, key: K) => void) => map.forEach(fn),
    map: <T>(fn: (value: V, key: K) => T) => Array.from(map.values()).map((v, i) => fn(v, Array.from(map.keys())[i])),
    filter: (fn: (value: V, key: K) => boolean) => {
      const filtered = Array.from(map.entries()).filter(([k, v]) => fn(v, k));
      return createMockCollection(filtered);
    },
    find: (fn: (value: V, key: K) => boolean) => {
      for (const [k, v] of map.entries()) {
        if (fn(v, k)) return v;
      }
      return undefined;
    },
    some: (fn: (value: V, key: K) => boolean) => {
      for (const [k, v] of map.entries()) {
        if (fn(v, k)) return true;
      }
      return false;
    },
    every: (fn: (value: V, key: K) => boolean) => {
      for (const [k, v] of map.entries()) {
        if (!fn(v, k)) return false;
      }
      return true;
    },
    reduce: <T>(fn: (acc: T, value: V, key: K) => T, initial: T) => {
      let acc = initial;
      for (const [k, v] of map.entries()) {
        acc = fn(acc, v, k);
      }
      return acc;
    },
    size: map.size,
    first: () => map.values().next().value,
    last: () => Array.from(map.values()).pop(),
    random: () => {
      const values = Array.from(map.values());
      return values[Math.floor(Math.random() * values.length)];
    },
    array: () => Array.from(map.values()),
    keyArray: () => Array.from(map.keys()),
    values: () => map.values(),
    keys: () => map.keys(),
    entries: () => map.entries(),
    [Symbol.iterator]: () => map[Symbol.iterator](),
  };
}
