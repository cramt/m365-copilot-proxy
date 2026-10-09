/**
 * Permissive CORS for every route, matching the old Hono `cors()` default.
 * `handleCors` returns true when it has fully handled a preflight (OPTIONS)
 * request, in which case we stop here; otherwise it appends the CORS headers
 * and the matched route runs as usual.
 */
export default defineEventHandler((event) => {
  if (handleCors(event, { origin: "*", methods: "*", allowHeaders: "*" })) {
    return;
  }
});
