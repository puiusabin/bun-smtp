/**
 * Benchmark target: smtp-server (npm package), run under Node.
 * Usage: node bench/servers/node-server.mjs <port>
 */
import { SMTPServer } from "smtp-server";

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
