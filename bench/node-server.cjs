"use strict";
const { SMTPServer } = require("smtp-server");
const port = parseInt(process.argv[2] ?? "2525", 10);
const server = new SMTPServer({
  authOptional: true,
  disableReverseLookup: true,
  onData(stream, _session, cb) {
    stream.on("data", () => {});
    stream.on("end", () => cb(null));
  },
});
server.listen(port, "127.0.0.1", () => process.stdout.write("ready\n"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
