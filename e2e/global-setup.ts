import { execFileSync } from "node:child_process";

// Re-seed Redis so expiring fixture keys are always present.
export default function globalSetup() {
  execFileSync("sh", ["docker/redis-seed.sh"], { stdio: "inherit" });
}
