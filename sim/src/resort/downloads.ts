/** One file's download: bytes so far, and its size when the server says (else null). */
export interface FileProgress {
  loaded: number;
  total: number | null;
  done: boolean;
}

/**
 * Overall progress (0-1) of a set of downloads. Files of known size count by bytes;
 * one of unknown size (compressed, no usable Content-Length) counts as the average
 * known size and jumps from 0 to done.
 */
export function downloadFraction(files: readonly FileProgress[]): number {
  if (files.length === 0) return 0;
  const sized = files.filter((f) => f.total !== null && f.total > 0);
  const guess = sized.length ? sized.reduce((s, f) => s + f.total!, 0) / sized.length : 1;
  let weight = 0;
  let got = 0;
  for (const f of files) {
    const w = f.total !== null && f.total > 0 ? f.total : guess;
    const part = f.done ? 1 : f.total ? Math.min(f.loaded / f.total, 1) : 0;
    weight += w;
    got += w * part;
  }
  return got / weight;
}

/** "42 MB" / "850 KB". */
export function formatBytes(bytes: number): string {
  return bytes >= 1e6 ? `${Math.round(bytes / 1e6)} MB` : `${Math.round(bytes / 1e3)} KB`;
}

/**
 * A `fetch` that reports byte progress across every file it's asked for. The body is
 * counted as it streams, so callers still use `.json()`, `.blob()` and `.arrayBuffer()`.
 */
export class Downloads {
  private readonly files: FileProgress[] = [];

  constructor(private readonly onProgress: (fraction: number, loadedBytes: number) => void) {}

  readonly fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const file: FileProgress = { loaded: 0, total: null, done: false };
    this.files.push(file);
    this.report();
    const res = await fetch(url, init);
    // A compressed response's Content-Length is the compressed size; we count decoded bytes.
    const length = Number(res.headers.get('content-length'));
    if (!res.headers.get('content-encoding') && length > 0) file.total = length;
    if (!res.ok || !res.body) {
      file.done = true;
      this.report();
      return res;
    }
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          file.loaded += chunk.byteLength;
          this.report();
          controller.enqueue(chunk);
        },
        flush: () => {
          file.done = true;
          this.report();
        },
      }),
    );
    return new Response(counted, { status: res.status, headers: res.headers });
  };

  private report(): void {
    this.onProgress(
      downloadFraction(this.files),
      this.files.reduce((s, f) => s + f.loaded, 0),
    );
  }
}
