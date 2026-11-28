// Run once against a fresh register_fixture. Each suite verifies its isolated dataset.
const path = require("node:path");
const { spawnSync } = require("node:child_process");
for (const suite of ["annual-planning", "research"]) {
  const result = spawnSync(process.execPath, [path.join(__dirname, suite + ".cjs")], {stdio:"inherit"});
  if (result.status !== 0) process.exit(result.status ?? 1);
}
