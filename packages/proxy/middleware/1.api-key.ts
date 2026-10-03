import { BlockList, isIP } from "node:net";
import {
  configuredApiKey,
  isAuthorized,
  openAIError,
  unauthorizedError,
} from "@m365-copilot/proxy-lib";

const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

// Sorted after 0.cors.ts so a 401 still carries CORS headers.
export default defineEventHandler((event) => {
  const pathname = getRequestURL(event).pathname;
  if (pathname === "/" || pathname === "/actions" || pathname.startsWith("/actions/")) {
    const address = event.node.req.socket.remoteAddress ?? "";
    const family = isIP(address);
    if (family === 0 || !loopback.check(address, family === 6 ? "ipv6" : "ipv4")) {
      return openAIError(403, {
        message: "Dashboard access is restricted to localhost.",
        type: "permission_error",
        code: "dashboard_local_only",
      });
    }
    return;
  }
  const apiKey = configuredApiKey();
  if (!apiKey || event.method === "OPTIONS" || !pathname.startsWith("/v1/")) return;
  if (!isAuthorized(getRequestHeader(event, "authorization"), apiKey)) return unauthorizedError();
});
