/**
 * Benchmark target: bun-smtp, run directly from source under Bun.
 * Usage: bun bench/servers/bun-server.ts <port>
 */
import { SMTPServer } from "../../src/smtp-server.ts";

const port = Number(process.argv[2]);

const server = new SMTPServer({
	authOptional: true,
	disableReverseLookup: true,
	async onData(stream, _session, callback) {
		for await (const _chunk of stream) {
			// drain and discard
		}
		callback(null);
	},
});

server.listen(port, "127.0.0.1", () => {
	console.log("READY");
});
