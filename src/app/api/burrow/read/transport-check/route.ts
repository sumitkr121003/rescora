/** Same-deployment POST probe. It performs no external requests and reads no body or secrets. */
export async function POST(): Promise<Response> {
  const requestId = crypto.randomUUID();
  const response = Response.json(
    { requestId, serverTimestamp: new Date().toISOString() },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Rescora-Request-Id": requestId,
        "X-Rescora-Route-Reached": "true",
        "X-Rescora-Rpc-Attempted": "false",
      },
    },
  );
  return response;
}
