import assert from "node:assert/strict";
import { test } from "node:test";
import { unit } from "../src/service.ts";

test("the unit runs padd serve with absolute paths, inside the desktop session", () => {
  const u = unit({ node: "/opt/node/bin/node", cli: "/home/me/padd/src/cli.ts", root: "/home/me/padd", log: "/home/me/.local/state/padd/padd.log" });
  assert.match(u, /^ExecStart=\/opt\/node\/bin\/node \/home\/me\/padd\/src\/cli\.ts serve$/m);
  assert.match(u, /^WorkingDirectory=\/home\/me\/padd$/m);
  assert.match(u, /^Restart=on-failure$/m);
  assert.match(u, /^WantedBy=graphical-session\.target$/m);
  assert.match(u, /^StandardOutput=append:\/home\/me\/\.local\/state\/padd\/padd\.log$/m);
});
