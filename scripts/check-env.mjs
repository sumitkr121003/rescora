import { getRuntimeEnvironment } from "../src/lib/environment.mjs";

try {
  const config = getRuntimeEnvironment();
  process.stdout.write(`Environment configuration valid (${config.network}).\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Invalid environment configuration.";
  process.stderr.write(`${message}\nSee .env.example for the required setting.\n`);
  process.exitCode = 1;
}
