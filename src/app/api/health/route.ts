import { getRuntimeEnvironment } from "@/lib/environment.mjs";

export async function GET() {
  try {
    const config = getRuntimeEnvironment();
    return Response.json(
      {
        status: "ok",
        application: "rescora",
        phase: "hackathon-demo",
        networkScope: config.network,
        integrations: {
          wallet: "account-only experimental; runtime unverified",
          burrow: "read pipeline experimental; assessment unavailable",
          ai: process.env.GROQ_API_KEY
            ? "configured for synthetic demo only"
            : "setup required for synthetic demo",
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
