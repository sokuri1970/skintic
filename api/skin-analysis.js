export const config = { api: { bodyParser: { sizeLimit: "5mb" } } };

const AILAB_URL = "https://www.ailabapi.com/api/portrait/analysis/skin-analysis";

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({ hasKey: Boolean(process.env.AILAB_API_KEY) });
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error_msg: "POST only" });
  }

  const key = process.env.AILAB_API_KEY;
  if (!key) {
    return res.status(500).json({ error_msg: "서버에 API 키가 설정되지 않았습니다." });
  }

  const { image } = req.body || {};
  if (!image) {
    return res.status(400).json({ error_msg: "사진 데이터가 없습니다." });
  }

  try {
    const buffer = Buffer.from(image.replace(/^data:image\/\w+;base64,/, ""), "base64");
    const form = new FormData();
    form.append("image", new Blob([buffer], { type: "image/jpeg" }), "skin.jpg");

    const upstream = await fetch(AILAB_URL, {
      method: "POST",
      headers: { "ailabapi-api-key": key },
      body: form
    });

    const text = await upstream.text();
    try {
      return res.status(upstream.status).json(JSON.parse(text));
    } catch {
      return res.status(502).json({ error_msg: "AILabTools 응답 해석 실패: " + text.slice(0, 200) });
    }
  } catch (err) {
    return res.status(502).json({ error_msg: "서버 오류: " + err.message });
  }
}
