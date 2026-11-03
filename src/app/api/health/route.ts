import { getRuntimeEnvironment } from "@/lib/environment.mjs";

export async function GET() {
  try {
    const config = getRuntimeEnvironment();
    return Response.json(
      {
        status: "ok",
        application: "rescora",
        phase: 1,
        networkScope: config.network,
        integrations: {
          wallet: "not-configured",
          burrow: "not-configured",
          ai: "not-configured",
          execution: "disabled",
        },
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "error", code: "INVALID_CONFIGURATION" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
