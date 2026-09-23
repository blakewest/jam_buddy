import { cp, mkdir, readdir } from "node:fs/promises";

async function copyStaticFiles(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await copyStaticFiles(path);
    else if (!path.endsWith(".ts")) {
      await mkdir(`dist/${directory}`, { recursive: true });
      await cp(path, `dist/${path}`);
    }
  }
}

await copyStaticFiles("src/frontend");
await cp("recordings", "dist/recordings", { recursive: true }).catch(error => {
  if (error.code !== "ENOENT") throw error;
});
