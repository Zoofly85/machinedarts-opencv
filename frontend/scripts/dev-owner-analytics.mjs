import { spawn } from "node:child_process";

const env = {
  ...process.env,
  VITE_OWNER_ANALYTICS_UI: "1",
};

const child = spawn("npx", ["vite"], {
  stdio: "inherit",
  shell: true,
  env,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
