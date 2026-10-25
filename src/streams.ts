import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";

/** The four durable files that carry one process's stdout/stderr evidence. */
export interface StreamPaths {
  readonly stdoutBin: string;
  readonly stdoutText: string;
  readonly stderrBin: string;
  readonly stderrText: string;
}

/** Process capture's narrow persistence seam. */
export interface StreamSink {
  append(kind: "stdout" | "stderr", raw: Buffer, text: string): Promise<void>;
  close(): Promise<void>;
}

export interface DurableStreamSinkOptions {
  /** Test-only fault hook; counts append calls independently of JSON writes. */
  readonly failAfterWrites?: number;
  /** Test-only fault hook that rejects every append. */
  readonly failStreams?: boolean;
}

type StreamFile = "stdout-bin" | "stdout-text" | "stderr-bin" | "stderr-text";

const streamFiles = (paths: StreamPaths): readonly (readonly [StreamFile, string])[] => [
  ["stdout-bin", paths.stdoutBin],
  ["stdout-text", paths.stdoutText],
  ["stderr-bin", paths.stderrBin],
  ["stderr-text", paths.stderrText],
];

const writeAll = async (handle: FileHandle, buffer: Buffer): Promise<void> => {
  let offset = 0;
  while (offset < buffer.byteLength) {
    const result = await handle.write(buffer, offset, buffer.byteLength - offset);
    if (result.bytesWritten <= 0 || result.bytesWritten > buffer.byteLength - offset) {
      throw new Error("stream sink write made no progress");
    }
    offset += result.bytesWritten;
  }
};

/**
 * One durable append-only sink for the four raw/display evidence files.
 *
 * Opening and closing are deliberately idempotent enough for cleanup paths:
 * close snapshots every opened handle, attempts sync and close for each one,
 * and reports the first failure only after all handles have been attempted.
 */
export class DurableFileStreamSink implements StreamSink {
  private readonly paths: StreamPaths;
  private readonly options: DurableStreamSinkOptions;
  private readonly handles = new Map<StreamFile, FileHandle>();
  private appendCount = 0;

  public constructor(paths: StreamPaths, options: DurableStreamSinkOptions = {}) {
    this.paths = paths;
    this.options = options;
  }

  public async open(): Promise<void> {
    if (this.handles.size > 0) throw new Error("stream sink is already open");
    try {
      for (const [name, file] of streamFiles(this.paths)) {
        this.handles.set(name, await fs.open(file, "a"));
      }
    } catch (error) {
      try {
        await this.close();
      } catch {
        // Preserve the opening failure; close() still attempted every handle.
      }
      throw error;
    }
  }

  public async append(kind: "stdout" | "stderr", raw: Buffer, text: string): Promise<void> {
    this.appendCount += 1;
    if (this.options.failStreams === true || (this.options.failAfterWrites !== undefined && this.appendCount > this.options.failAfterWrites)) {
      throw new Error("injected stream write failure");
    }
    const rawHandle = this.handles.get(`${kind}-bin`);
    const textHandle = this.handles.get(`${kind}-text`);
    if (rawHandle === undefined || textHandle === undefined) throw new Error("stream sink is not open");
    if (raw.byteLength > 0) await writeAll(rawHandle, raw);
    if (text.length > 0) await writeAll(textHandle, Buffer.from(text, "utf8"));
  }

  public async close(): Promise<void> {
    const handles = [...this.handles.values()];
    this.handles.clear();
    let firstError: unknown;
    for (const handle of handles) {
      try {
        await handle.sync();
      } catch (error) {
        firstError ??= error;
      }
      try {
        await handle.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
