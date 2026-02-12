/**
 * Webhook Proxy for MS Teams Bot
 * 
 * Runs on the Shakudo microservice (hyperplane-pipelines namespace).
 * Forwards all incoming Bot Framework webhook traffic to the Teams bot
 * running on the JupyterHub pod (hyperplane-jhub namespace).
 * 
 * This proxy exists because:
 * 1. Shakudo microservices get webhook URLs that bypass Keycloak auth
 * 2. The Teams bot needs to run on the same pod as OpenCode (localhost:4096)
 * 3. Cross-namespace networking on declared container ports works via Istio
 */

const PROXY_PORT = parseInt(process.env.PROXY_PORT || "8787");
const TARGET_URL = process.env.TARGET_URL || "http://hyperhub-svc-456b71.hyperplane-jhub.svc.cluster.local:3000";

console.log(`[webhook-proxy] Starting proxy on port ${PROXY_PORT}`);
console.log(`[webhook-proxy] Forwarding to ${TARGET_URL}`);

const server = Bun.serve({
  port: PROXY_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const targetUrl = `${TARGET_URL}${url.pathname}${url.search}`;
    
    try {
      // Forward the request with all headers and body
      const headers = new Headers(req.headers);
      headers.delete("host"); // Let the target set its own host
      
      const response = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined,
        signal: AbortSignal.timeout(30000),
      });
      
      // Forward the response back
      const responseHeaders = new Headers(response.headers);
      console.log(`[webhook-proxy] ${req.method} ${url.pathname} -> ${response.status} (${targetUrl})`);
      
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    } catch (error) {
      console.error(`[webhook-proxy] Error proxying ${req.method} ${url.pathname}: ${error}`);
      return new Response(JSON.stringify({ error: "Proxy error", details: String(error) }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      });
    }
  },
});

console.log(`[webhook-proxy] Proxy listening on port ${server.port}`);
