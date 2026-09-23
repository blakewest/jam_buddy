import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createServer } from "./src/services/http-server.js";

export { createServer } from "./src/services/http-server.js";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3210);
  const server = createServer();
  server.on("error", error => { console.error(`Server could not start (${"code" in error ? error.code : error.message}).`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Jam Partner: http://127.0.0.1:${port}`));
}
