function buildUpstreamUrl(scheme, target, search) {
  const cleanTarget = String(target || "").replace(/^\/+/, "");
  const [hostAndPath, targetQuery = ""] = cleanTarget.split("?");
  const upstream = new URL(`${scheme}://${hostAndPath}`);

  if (targetQuery) {
    upstream.search = targetQuery;
  }

  if (search) {
    const incoming = new URLSearchParams(search);
    for (const [key, value] of incoming.entries()) {
      upstream.searchParams.set(key, value);
    }
  }

  return upstream;
}

function rewriteLocation(location, scheme, proxyPrefix, targetHost) {
  if (!location) return location;

  try {
    const absolute = new URL(location);
    if (absolute.hostname) {
      return `/${proxyPrefix}/${absolute.host}${absolute.pathname}${absolute.search}${absolute.hash}`;
    }
  } catch {}

  if (location.startsWith("/")) {
    return `/${proxyPrefix}/${targetHost}${location}`;
  }

  return location;
}

module.exports = async function handler(req, res) {
  const { scheme = "https", target = "" } = req.query || {};

  if (!target) {
    res.statusCode = 400;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end("missing target");
    return;
  }

  const original = new URL(req.url, "http://localhost");
  const upstreamUrl = buildUpstreamUrl(scheme, target, original.search);
  const targetHost = upstreamUrl.host;

  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (
      [
        "host",
        "connection",
        "content-length",
        "accept-encoding",
        "x-forwarded-host",
        "x-forwarded-proto",
      ].includes(lower)
    ) {
      continue;
    }
    headers[key] = value;
  }
  headers.host = upstreamUrl.host;

  const init = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (!["GET", "HEAD"].includes(req.method || "")) {
    init.body = req;
  }

  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, init);
  } catch (error) {
    res.statusCode = 502;
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(`upstream fetch failed: ${error.message}`);
    return;
  }

  res.statusCode = upstreamResponse.status;

  for (const [key, value] of upstreamResponse.headers.entries()) {
    const lower = key.toLowerCase();
    if (["content-length", "transfer-encoding", "location"].includes(lower)) {
      continue;
    }
    res.setHeader(key, value);
  }

  const contentType = upstreamResponse.headers.get("content-type");
  if (contentType) {
    res.setHeader("content-type", contentType);
  }

  const location = upstreamResponse.headers.get("location");
  if (location) {
    const proxyPrefix = String(scheme).toLowerCase() === "http" ? "httpproxy" : "proxy";
    res.setHeader("location", rewriteLocation(location, scheme, proxyPrefix, targetHost));
  }

  if (req.method === "HEAD" || upstreamResponse.body == null) {
    res.end();
    return;
  }

  const body = Buffer.from(await upstreamResponse.arrayBuffer());
  res.end(body);
};
