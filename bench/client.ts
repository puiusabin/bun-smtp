/**
 * Minimal raw-TCP SMTP client used to drive both benchmark targets identically.
 * Adapted from test/integration.test.ts's SMTPClient, with the STARTTLS path
 * removed since the benchmark never needs it.
 *
 * `write()` returns fewer bytes than requested when the socket's send buffer
 * is full (documented Bun backpressure behavior) — writes must be queued and
 * retried on `drain`, or large DATA bodies get silently truncated mid-write.
 */

type RawSocket = {
	write(data: Uint8Array, byteOffset?: number, byteLength?: number): number;
	end(): void;
};

const encoder = new TextEncoder();

export class SMTPClient {
	private socket: RawSocket | null = null;
	private buffer = "";
	private resolve: ((line: string) => void) | null = null;
	private lines: string[] = [];
	private drainWaiters: Array<() => void> = [];

	async connect(port: number): Promise<string> {
		return new Promise((outerResolve) => {
			const client = this;
			Bun.connect({
				hostname: "127.0.0.1",
				port,
				socket: {
					open(socket) {
						client.socket = socket as unknown as RawSocket;
					},
					data(_socket, rawData) {
						const chunk = Buffer.from(rawData).toString("utf8");
						client.buffer += chunk;

						let newlineIdx = client.buffer.indexOf("\n");
						while (newlineIdx !== -1) {
							const line = client.buffer
								.slice(0, newlineIdx)
								.replace(/\r$/, "");
							client.buffer = client.buffer.slice(newlineIdx + 1);
							newlineIdx = client.buffer.indexOf("\n");
							if (client.resolve) {
								const res = client.resolve;
								client.resolve = null;
								res(line);
							} else {
								client.lines.push(line);
							}
						}
					},
					drain(_socket) {
						const waiters = client.drainWaiters;
						client.drainWaiters = [];
						for (const w of waiters) w();
					},
					close() {},
					error(_socket, err) {
						console.error("client error", err);
					},
				},
			}).then(() => {
				client.readLine().then(outerResolve);
			});
		});
	}

	readLine(): Promise<string> {
		if (this.lines.length > 0) {
			return Promise.resolve(this.lines.shift() ?? "");
		}
		return new Promise((resolve) => {
			this.resolve = resolve;
		});
	}

	async readResponse(): Promise<string> {
		let last = "";
		while (true) {
			const line = await this.readLine();
			last = line;
			if (/^\d{3} /.test(line) || !/^\d{3}-/.test(line)) {
				return last;
			}
		}
	}

	/** Writes the full buffer, looping on backpressure until every byte is sent. */
	private async writeAll(data: Uint8Array): Promise<void> {
		const socket = this.socket;
		if (!socket) throw new Error("not connected");
		let offset = 0;
		while (offset < data.length) {
			const written = socket.write(data, offset, data.length - offset);
			if (written < 0) throw new Error("socket closed during write");
			offset += written;
			if (offset < data.length) {
				await new Promise<void>((resolve) => this.drainWaiters.push(resolve));
			}
		}
	}

	send(line: string): Promise<void> {
		return this.writeAll(encoder.encode(`${line}\r\n`));
	}

	sendRaw(data: string): Promise<void> {
		return this.writeAll(encoder.encode(data));
	}

	close(): void {
		try {
			this.socket?.end();
		} catch {}
	}
}
