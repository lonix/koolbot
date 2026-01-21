/**
 * Creates a mock Discord.js Collection with common methods
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createMockCollection<K, V>(entries: [K, V][] = []): any {
  const map = new Map(entries);
  
  return {
    get: (key: K): V | undefined => map.get(key),
    set: (key: K, value: V): Map<K, V> => map.set(key, value),
    has: (key: K): boolean => map.has(key),
    delete: (key: K): boolean => map.delete(key),
    clear: (): void => map.clear(),
    forEach: (fn: (value: V, key: K) => void): void => map.forEach(fn),
    map: <T>(fn: (value: V, key: K) => T): T[] => Array.from(map.values()).map((v, i) => fn(v, Array.from(map.keys())[i])),
    filter: (fn: (value: V, key: K) => boolean): ReturnType<typeof createMockCollection<K, V>> => {
      const filtered = Array.from(map.entries()).filter(([k, v]) => fn(v, k));
      return createMockCollection(filtered);
    },
    find: (fn: (value: V, key: K) => boolean): V | undefined => {
      for (const [k, v] of map.entries()) {
        if (fn(v, k)) return v;
      }
      return undefined;
    },
    some: (fn: (value: V, key: K) => boolean): boolean => {
      for (const [k, v] of map.entries()) {
        if (fn(v, k)) return true;
      }
      return false;
    },
    every: (fn: (value: V, key: K) => boolean): boolean => {
      for (const [k, v] of map.entries()) {
        if (!fn(v, k)) return false;
      }
      return true;
    },
    reduce: <T>(fn: (acc: T, value: V, key: K) => T, initial: T): T => {
      let acc = initial;
      for (const [k, v] of map.entries()) {
        acc = fn(acc, v, k);
      }
      return acc;
    },
    size: map.size,
    first: () => map.values().next().value,
    last: () => Array.from(map.values()).pop(),
    random: (): V | undefined => {
      const values = Array.from(map.values());
      return values[Math.floor(Math.random() * values.length)];
    },
    array: (): V[] => Array.from(map.values()),
    keyArray: (): K[] => Array.from(map.keys()),
    values: (): IterableIterator<V> => map.values(),
    keys: (): IterableIterator<K> => map.keys(),
    entries: (): IterableIterator<[K, V]> => map.entries(),
    [Symbol.iterator]: (): IterableIterator<[K, V]> => map[Symbol.iterator](),
  };
}
