// Library APIs every target of owl's dist has (packages/owl/build_target.mjs)
// that TypeScript 5.9's lib does not declare yet. Upsert: Chrome 145,
// Firefox 144, Safari 26.2, Node 26 (MDN browser-compat-data).
interface Map<K, V> {
  getOrInsert(key: K, value: V): V;
  getOrInsertComputed(key: K, callback: (key: K) => V): V;
}

interface WeakMap<K extends WeakKey, V> {
  getOrInsert(key: K, value: V): V;
  getOrInsertComputed(key: K, callback: (key: K) => V): V;
}
