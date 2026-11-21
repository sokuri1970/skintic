const { randomBytes } = require("node:crypto");

// Vercel Production uses AILABTOOLS_API_KEY; AILAB_API_KEY is a legacy alias.
const AILAB_URL = "https://www.ailabapi.com/api/portrait/analysis/skin-analysis";
const MAX_IMAGE_BYTES = 2_000_000;

function upstreamError(status, payload) {
  const code = payload?.error_detail?.code;
  const suffix = typeof code === "string" && /^[A-Z0-9_]{1,70}$/.test(code) ? " (" + code + ")" : "";
  const providerStatus = Number(payload?.error_detail?.status_code || payload?.error_code);
  const effective = status >= 400 ? status : providerStatus;

  if ([401, 402, 403, 429].includes(effective) && code !== "ERROR_ILLEGAL_FILE") {
    return [502, "AILabTools rejected the request. Check the API key, Skin Analyze Basic access, and account quota." + suffix];
  }
  if (effective === 413) return [413, "Please choose a photo under 2 MB." + suffix];
  if (effective === 415 || effective === 422 || code === "ERROR_FACE_NOT_FOUND" || code === "ERROR_ILLEGAL_FILE") {
    return [422, "AILabTools could not analyze this photo. Try a well-lit, front-facing photo with your face filling the frame." + suffix];
  }
  return [502, "AILabTools could not process the request." + suffix];
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const key = process.env.AILABTOOLS_API_KEY?.trim() || process.env.AILAB_API_KEY?.trim();
  if (req.method === "GET") return res.status(200).json({ hasKey: Boolean(key) });
  const fail = (status, error_msg) => res.status(status).json({ error_msg });
  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return fail(405, "Use GET or POST for this endpoint.");
  }
  if (!key) return fail(503, "The Vercel environment variable AILABTOOLS__KEY is missing.");

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); }
    catch { return fail(400, "The JSON request is invalid."); }
  }
  const image = body?.imageBase64;
  if (typeof image !== "string" || !image) return fail(400, "No photo was provided.");
  const encoded = image.replace(/^data:image\/jpeg;base64,/i, "");
  if (encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4) return fail(413, "Please choose a photo under 2 MB.");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    return fail(400, "Please choose a valid JPEG photo.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) return fail(413, "Please choose a photo under 2 MB.");
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
    return fail(400, "Please choose a valid JPEG photo.");
  }

  const boundary = "skintic-" + randomBytes(18).toString("hex");
  const multipart = Buffer.concat([
    Buffer.from("--" + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="skin.jpg"\r\nContent-Type: image/jpeg\r\n\r\n'),
    bytes,
    Buffer.from("\r\n--" + boundary + "--\r\n")
  ]);
  try {
    const upstream = await fetch(AILAB_URL, {
      method: "POST",
      headers: {
        "ailabapi-api-key": key,'h1yyYVoI4LTKyHrdyyghhlZOoBFwlTs3GRPTQuiRwvXEZx25GvOosWjjbc7JzPXH'
        "Content-Type": "multipart/form-data; boundary=" + boundary
      },
      body: multipart,
      signal: AbortSignal.timeout(24000)
    });
    const payload = await upstream.json().catch(error => {
      if (error instanceof SyntaxError) return null;
      throw error;
    });
    if (!upstream.ok || (payload?.error_code != null && String(payload.error_code) !== "0")) {
      return fail(...upstreamError(upstream.status, payload));
    }
    const result = payload?.result ?? payload?.data?.result;
    const flag = field => field?.value === 1 ? true : field?.value === 0 ? false : null;
    const count = fields => {
      const values = fields.map(name => flag(result?.[name])).filter(value => value !== null);
      return values.length ? { detected: values.filter(Boolean).length, checked: values.length } : null;
    };
    const observations = {
      skinType: ['Oily', 'Dry', 'Normal', 'Combination'][result?.skin_type?.skin_type] ?? null,
      pores: count(['pores_forehead', 'pores_left_cheek', 'pores_right_cheek', 'pores_jaw']),
      fineLines: count(['forehead_wrinkle', 'crows_feet', 'eye_finelines', 'glabella_wrinkle', 'nasolabial_fold']),
      spots: flag(result?.skin_spot)
    };
    if (Object.values(observations).every(value => value === null)) {
      return fail(502, "AILabTools Basic did not return usable observations. Try a clearer photo.");
    }
    return res.status(200).json({ observations });
  } catch (error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") {
      return fail(504, "AILabTools timed out. Please try again.");
    }
    return fail(502, "AILabTools could not be reached. Please try again.");
  }
};
