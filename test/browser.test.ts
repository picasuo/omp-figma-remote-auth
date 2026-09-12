import assert from "node:assert/strict";
import test from "node:test";
import { isAuthorizationEntry, openBrowser } from "../src/browser.ts";
import type { Exec } from "../src/browser.ts";

const entry = "http://127.0.0.1:19876/a/abcdefghijklmnopqrstuv";
const success = { stdout: "", stderr: "", code: 0, killed: false };

test("browser dispatch uses independent argv, bounded timeout and the operation signal", async () => {
  const signal = new AbortController().signal;
  for (const [platform, command, args] of [
    ["darwin", "open", [entry]], ["linux", "xdg-open", [entry]],
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler", entry]],
  ] as const) {
    let calls = 0;
    const exec: Exec = async (actualCommand, actualArgs, options) => {
      calls++;
      assert.equal(actualCommand, command);
      assert.deepEqual(actualArgs, args);
      assert.deepEqual(options, { timeout: 5000, signal });
      return success;
    };
    assert.equal(await openBrowser(entry, exec, { platform, signal }), true);
    assert.equal(calls, 1);
  }
});

test("invalid or noncanonical entries never execute a command", async () => {
  let calls = 0;
  const exec: Exec = async () => { calls++; return success; };
  for (const value of [
    "https://www.figma.com/oauth/mcp?client_id=secret", entry.replace("127.0.0.1", "localhost"),
    entry.replace("127.0.0.1", "127.1"), entry.replace("http:", "https:"),
    entry.replace(":19876", ":0"), entry.replace(":19876", ":65536"), entry.replace(":19876", ":019876"),
    entry.replace("127.0.0.1", "user@127.0.0.1"), entry + "?", entry + "#", entry + "?x=1",
    entry + "\n", entry + "\r", entry + " ", " " + entry, entry.replace("/a/", "/a/../a/"),
    entry + "/", entry.slice(0, -1), entry + "z", entry.replace("/a/", "/%61/"),
    entry.replace("/a/", "/callback/"), entry.replace("abcdefghijklmnopqrstuv", "`$(open)abcdefghijklmno"),
  ]) {
    assert.equal(isAuthorizationEntry(value), false);
    assert.equal(await openBrowser(value, exec, { platform: "darwin" }), false);
    assert.equal(calls, 0);
  }
  assert.equal(isAuthorizationEntry(entry, "http://127.0.0.1:19876/callback"), true);
  for (const cb of ["http://127.0.0.1:19877/callback", "http://localhost:19876/callback", "http://127.0.0.1:19876/callback?x=1"]) {
    assert.equal(isAuthorizationEntry(entry, cb), false);
  }
  assert.equal(await openBrowser(entry, exec, { platform: "freebsd" }), false);
  assert.equal(calls, 0);
});

test("browser errors, missing executable, timeouts and nonzero exits fall back without stderr", async () => {
  for (const result of [{ ...success, code: 1 }, { ...success, killed: true }]) {
    assert.equal(await openBrowser(entry, async () => result, { platform: "linux" }), false);
  }
  assert.equal(await openBrowser(entry, async () => { throw new Error("private stderr or missing executable"); }, { platform: "linux" }), false);
});

test("cancellation before and during exec preserves OAuth cancellation semantics", async () => {
  const before = new AbortController();
  before.abort(new Error("private cancellation"));
  let calls = 0;
  await assert.rejects(openBrowser(entry, async () => { calls++; return success; }, { platform: "darwin", signal: before.signal }), /^FigmaRemoteAuthError: Figma authorization cancelled\.$/u);
  assert.equal(calls, 0);
  for (const throws of [false, true]) {
    const controller = new AbortController();
    await assert.rejects(openBrowser(entry, async () => {
      controller.abort();
      if (throws) throw new Error("private exec error");
      return success;
    }, { platform: "darwin", signal: controller.signal }), /authorization cancelled/u);
  }
});
