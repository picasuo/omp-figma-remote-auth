import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));

test("the package owns one credential-free Figma MCP declaration", () => {
  const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const mcp = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp, { mcpServers: { figma: { type: "http", url: "https://mcp.figma.com/mcp" } } });
  assert.ok(manifest.files.includes(".mcp.json"));
  assert.deepEqual(manifest.omp, { extensions: ["./index.ts"] });
  assert.equal(existsSync(join(root, "mcp.json")), false);
  assert.deepEqual(readdirSync(join(root, "src")).filter(name => /mcp.*\.json$/u.test(name)), []);
  assert.ok(readFileSync(join(root, ".gitignore"), "utf8").split("\n").includes("!/.mcp.json"));
  assert.equal(manifest.scripts?.uninstall, undefined);
});
