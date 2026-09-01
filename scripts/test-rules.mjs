// Runs the security-rules suite against the Firestore emulator.
//
// The emulator is a JVM process, so it needs Java. Rather than require Java to
// be on PATH — which it often is not immediately after installing, because an
// already-open terminal keeps the environment it started with — this locates a
// JDK itself and hands it to the emulator.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const WINDOWS = process.platform === "win32";

function javaOnPath() {
  const probe = spawnSync("java", ["-version"], { stdio: "ignore", shell: WINDOWS });
  return probe.status === 0;
}

// Where the common installers put a JDK, newest first.
function findJdkHome() {
  const roots = WINDOWS
    ? [
        "C:\\Program Files\\Microsoft",
        "C:\\Program Files\\Eclipse Adoptium",
        "C:\\Program Files\\Java",
        "C:\\Program Files\\Amazon Corretto",
        path.join(os.homedir(), "scoop", "apps"),
      ]
    : ["/usr/lib/jvm", "/Library/Java/JavaVirtualMachines", "/opt/homebrew/opt"];

  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const candidates = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /jdk|java|temurin|corretto/i.test(d.name))
      .map((d) => path.join(root, d.name))
      .sort()
      .reverse();

    for (const dir of candidates) {
      // macOS nests the real home one level down.
      for (const home of [dir, path.join(dir, "Contents", "Home")]) {
        const bin = path.join(home, "bin", WINDOWS ? "java.exe" : "java");
        if (fs.existsSync(bin)) return home;
      }
    }
  }
  return null;
}

const env = { ...process.env };

if (!javaOnPath()) {
  const home = process.env.JAVA_HOME || findJdkHome();
  if (!home) {
    console.error(`
Java is required — the Firestore emulator runs on the JVM.

  Windows   winget install --id Microsoft.OpenJDK.21 -e
  macOS     brew install openjdk@21
  Linux     sudo apt install openjdk-21-jdk

Then run this again. You do not need to restart your terminal; this script
finds the JDK itself.
`);
    process.exit(1);
  }
  env.JAVA_HOME = home;
  env.PATH = path.join(home, "bin") + path.delimiter + env.PATH;
  console.log(`Using JDK at ${home}`);
}

// Passed as ONE command string rather than an argv array. With shell: true the
// array form is concatenated without quoting, so "vitest run rules/" arrives as
// three separate arguments and the CLI rejects it.
const command = 'firebase emulators:exec --only firestore "vitest run rules/"';
const child = spawn(command, { stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (err) => {
  console.error(
    err.code === "ENOENT"
      ? "firebase CLI not found. Install it with:  npm install -g firebase-tools"
      : err.message
  );
  process.exit(1);
});
