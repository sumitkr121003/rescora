/** Configuration-only status endpoint. It deliberately performs no RPC call. */
export async function GET(request: Request): Promise<Response> {
  // Accessing request headers makes this route request-time dynamic, so the
  // server environment flag is never baked into a static build response.
  request.headers.get("x-rescora-request-id");
  return Response.json(
    { fastNearConfigured: Boolean(process.env.FASTNEAR_API_KEY?.trim()) },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
