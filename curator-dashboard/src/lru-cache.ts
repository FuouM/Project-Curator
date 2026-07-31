export class LruCache<V> {
  private map = new Map<number, V>();
  private maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
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
    this.map.delete(key);
    this.map.set(key, value);

    if (this.map.size > this.maxSize) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey !== undefined) {
        const oldValue = this.map.get(oldestKey);
        this.revoke(oldValue);
        this.map.delete(oldestKey);
      }
    }
  }

  has(key: number): boolean {
    return this.map.has(key);
  }

  delete(key: number): void {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.revoke(value);
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.forEach((value) => this.revoke(value));
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }

  keys(): IterableIterator<number> {
    return this.map.keys();
  }

  private revoke(value: V | undefined): void {
    if (typeof value === "string" && value.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(value);
      } catch (_) {}
    }
  }
}
