/**
 * Stateful SMTP protocol parser.
 *
 * Two modes:
 *  1. Command mode  – splits incoming bytes on \r\n or \n, returns complete lines.
 *  2. Data mode     – dot-unstuffs the email body per RFC 5321 §4.5.2, signals
 *                     end on the \r\n.\r\n terminator.
 *
 * No Node streams. No EventEmitter. Just a class you feed buffers to.
 */

export type DataCallbacks = {
  /** Called for each decoded chunk during DATA mode. */
  onData(chunk: Buffer): void;
  /**
   * Called once \r\n.\r\n is found.
   * @param byteLength total unescaped bytes pushed via onData
   * @param sizeExceeded whether byteLength > configured max
   */
  onDataEnd(byteLength: number, sizeExceeded: boolean): void;
  /**
   * Called with bytes that arrived after the terminator (pipelined commands).
   * The caller should re-inject these into command parsing.
   */
  onDataRemainder(remainder: Buffer): void;
};

const END_SEQ = Buffer.from("\r\n.\r\n"); // 5 bytes
const EMPTY_BUFFER = Buffer.alloc(0);

export class SMTPParser {
  // Command mode: partial bytes not yet terminated by \n
  private _remainder: Buffer | null = null;
  // Data mode: carry last ≤ 4 bytes across chunk boundaries for terminator detection
  private _lastBytes: Buffer | null = null;
  private _dataMode = false;
  private _dataBytes = 0;
  private _dataMaxBytes = Infinity;
  private _callbacks: DataCallbacks | null = null;
  isClosed = false;

  // ---- Command mode -------------------------------------------------------

  /**
   * Feed a raw TCP chunk in command mode.
   * Returns complete SMTP command lines (decoded as UTF-8).
   * Must NOT be called while in data mode.
   */
  feedCommandMode(chunk: Buffer): string[] {
    if (this.isClosed || this._dataMode) return [];

    const buf = this._remainder ? Buffer.concat([this._remainder, chunk]) : chunk;
    const lines: string[] = [];
    let pos = 0;

    while (true) {
      const nl = buf.indexOf(0x0a, pos);
      if (nl === -1) break;
      const end = nl > pos && buf[nl - 1] === 0x0d ? nl - 1 : nl;
      lines.push(buf.subarray(pos, end).toString("utf8"));
      pos = nl + 1;
    }

    this._remainder = pos < buf.length ? buf.subarray(pos) : null;
    return lines;
  }

  // ---- Data mode ----------------------------------------------------------

  /**
   * Switch to data mode and register callbacks.
   * Any un-newline-terminated bytes from the previous command chunk are
   * treated as the start of the message body.
   */
  startDataMode(maxBytes: number, callbacks: DataCallbacks): void {
    this._dataMode = true;
    this._dataBytes = 0;
    this._dataMaxBytes = (maxBytes && Number(maxBytes)) || Infinity;
    this._lastBytes = null;
    this._callbacks = callbacks;

    // Flush any accumulated command-mode remainder into the data stream.
    // (Rare: DATA command and body start in the same TCP packet)
    if (this._remainder && this._remainder.length > 0) {
      const buf = this._remainder;
      this._remainder = null;
      this._feedDataStream(buf);
    }
  }

  /**
   * Feed a raw TCP chunk in data mode.
   * Decoded bytes are delivered via DataCallbacks.
   */
  feedDataMode(chunk: Buffer): void {
    if (!this._dataMode || this.isClosed) return;
    this._feedDataStream(chunk);
  }

  get dataMode(): boolean {
    return this._dataMode;
  }

  // ---- Flush --------------------------------------------------------------

  /**
   * Flush partial command-mode remainder when socket closes.
   */
  flush(): string[] {
    if (this._remainder && this._remainder.length > 0 && !this.isClosed) {
      const buf = this._remainder;
      this._remainder = null;
      return [buf.toString("utf8")];
    }
    return [];
  }

  // ---- Private: dot-unstuffing (faithful port of smtp-stream.js) ----------

  private _feedDataStream(chunk: Buffer): void {
    if (!this._callbacks) return;

    // Prepend buffered tail from previous chunk for boundary detection
    if (this._lastBytes && this._lastBytes.length > 0) {
      chunk = Buffer.concat([this._lastBytes, chunk]);
      this._lastBytes = null;
    }

    const len = chunk.length;

    // Edge case: very first data byte(s) form the terminator ".\r\n"
    // (client sent DATA immediately followed by "\r\n.\r\n" or just ".\r\n")
    if (this._dataBytes === 0 && len >= 3 &&
        chunk[0] === 0x2e && chunk[1] === 0x0d && chunk[2] === 0x0a) {
      this._endDataMode(EMPTY_BUFFER, chunk.subarray(3));
      return;
    }

    // Edge case: escape dot ".." at the very start (first data byte, no prior \n)
    let start = 0;
    if (this._dataBytes === 0 && len >= 2 && chunk[0] === 0x2e && chunk[1] === 0x2e) {
      start = 1; // skip the escape dot, fall through
    }

    // Main scan: look for \r\n.\r\n or a dot-escape ".." at the start of a line.
    // Uses a labeled continue to restart the inner loop after an escape without
    // allocating a closure (replaces the previous setImmediate recursion).
    scan: while (true) {
      const clen = chunk.length;
      for (let i = start + 2; i < clen - 2; i++) {
        // A '.' at position i is "at the start of a line" when preceded by \n
        if (chunk[i] === 0x2e && chunk[i - 1] === 0x0a) {
          // Check for the terminator \r\n.\r\n
          if (Buffer.compare(chunk.subarray(i - 2, i + 3), END_SEQ) === 0) {
            // chunk.subarray(start, i) includes the \r\n that terminates the last line
            this._endDataMode(chunk.subarray(start, i), chunk.subarray(i + 3));
            return;
          }

          // Check for dot-escape: ".." (escape dot followed by content dot)
          if (chunk[i + 1] === 0x2e) {
            const before = chunk.subarray(start, i);
            if (before.length > 0) {
              this._dataBytes += before.length;
              this._callbacks.onData(before);
            }
            // Skip the escape dot; content dot at i+1 stays in the stream.
            // After the escape, chunk[i+1] is '.' (not '\n'), so no valid
            // terminator or escape can begin at i+1 or i+2 — safe to jump to i+3.
            start = i + 1;
            continue scan;
          }
        }
      }
      break;
    }

    // No terminator or escape found. Buffer the last 4 bytes for next chunk.
    const remaining = chunk.subarray(start);
    const keepLen = Math.min(4, remaining.length);
    const emitLen = remaining.length - keepLen;

    if (emitLen > 0) {
      const emit = remaining.subarray(0, emitLen);
      this._dataBytes += emit.length;
      this._callbacks.onData(emit);
    }

    this._lastBytes = remaining.subarray(emitLen);
  }

  private _endDataMode(dataChunk: Buffer, remainder: Buffer): void {
    if (!this._callbacks) return;

    if (dataChunk.length > 0) {
      this._dataBytes += dataChunk.length;
      this._callbacks.onData(dataChunk);
    }

    const byteLength = this._dataBytes;
    const sizeExceeded = byteLength > this._dataMaxBytes;

    this._dataMode = false;
    this._dataBytes = 0;
    this._lastBytes = null;
    const cbs = this._callbacks;
    this._callbacks = null;

    cbs.onDataEnd(byteLength, sizeExceeded);

    if (remainder.length > 0) {
      cbs.onDataRemainder(remainder);
    }
  }
}
