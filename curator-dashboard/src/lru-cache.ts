export class LruCache<V> {
  private map = new Map<number, V>();
  private maxSize: number;
  private onEvict?: (key: number, value: V) => void;

  constructor(maxSize: number, onEvict?: (key: number, value: V) => void) {
    this.maxSize = maxSize;
    this.onEvict = onEvict;
  }

  get(key: number): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  set(key: number, value: V): void {
    if (this.map.has(key)) {
      const prev = this.map.get(key);
      this.map.delete(key);
      if (prev !== value) {
        this.evict(key, prev);
      }
    }
    this.map.set(key, value);

    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldValue = this.map.get(oldestKey);
        this.map.delete(oldestKey);
        this.evict(oldestKey, oldValue);
      }
    }
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  delete(key: number): void {
    if (this.map.has(key)) {
      const oldValue = this.map.get(key);
      this.map.delete(key);
      this.evict(key, oldValue);
    }
  }

  clear(): void {
    this.map.forEach((value, key) => this.evict(key, value));
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<number> {
    return this.map.keys();
  }

  private evict(key: number, value: V | undefined): void {
    if (value === undefined) return;
    if (this.onEvict) {
      try {
        this.onEvict(key, value);
      } catch (_) {}
    }
    this.revoke(value);
  }

  private revoke(value: V | undefined): void {
    if (typeof value === "string" && value.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(value);
      } catch (_) {}
    }
  }
}


