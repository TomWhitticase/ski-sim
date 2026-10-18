import { describe, expect, it } from 'vitest';

import { clearPose, loadPose, savePose } from './pose';

class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  get length() {
    return this.data.size;
  }
  clear() {
    this.data.clear();
  }
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  key(i: number) {
    return [...this.data.keys()][i] ?? null;
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
}

describe('pose storage', () => {
  const pose = { east: 123.456, north: -789.01, altitude: 2701.33, heading: 200.04, pitch: -8 };

  it('round-trips per resort, rounded to 0.1', () => {
    const storage = new MemoryStorage();
    savePose(storage, 'val-thorens', pose);
    expect(loadPose(storage, 'val-thorens')).toEqual({
      east: 123.5,
      north: -789,
      altitude: 2701.3,
      heading: 200,
      pitch: -8,
    });
    expect(loadPose(storage, 'courchevel')).toBeNull();
    clearPose(storage, 'val-thorens');
    expect(loadPose(storage, 'val-thorens')).toBeNull();
  });

  it('ignores corrupt or incomplete data', () => {
    const storage = new MemoryStorage();
    storage.setItem('ski-sim.pose.val-thorens', '{not json');
    expect(loadPose(storage, 'val-thorens')).toBeNull();
    storage.setItem('ski-sim.pose.val-thorens', JSON.stringify({ v: 1, east: 1 }));
    expect(loadPose(storage, 'val-thorens')).toBeNull();
  });
});
