exports.handler = async function (event) {
  // Only allow POST
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  // Parse address from request body
  let address;
  try {
    const body = JSON.parse(event.body || "{}");
    address = body.address;
    if (!address) throw new Error("missing address");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Send { address: '...' } in request body" }) };
  }

  // API key from Netlify environment variable
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set in Netlify environment variables" })
    };
  }

  const prompt = `You are a real estate investment analyst for Pennsylvania properties.

For the property address below, return ONLY a JSON object — no markdown, no code fences, no explanation.

Required fields:
{
  "address": "full formatted address string",
  "beds": "e.g. 3 bed / 1 bath",
  "sqft": "e.g. 1,200 sqft",
  "year": "e.g. Built 1965",
  "type": "e.g. Single Family",
  "county": "e.g. Allegheny County",
  "acq": 25000,
  "arv": 150000,
  "rehab": 60000,
  "rent": 1100,
  "carry": 400,
  "notes": "Short investor insight about this property and neighborhood.",
  "zillow": "https://www.zillow.com/homes/STREET-CITY-STATE-ZIP_rb/",
  "redfin": "https://www.redfin.com/search?location=ENCODED",
  "trulia": "https://www.trulia.com/p/pa/CITY/ADDRESS/"
}

Rules:
- acq = realistic distressed/auction acquisition price (integer)
- arv = after repair value based on recent comparable sales (integer)
- rehab = full rehab estimate x2 conservative buffer (integer)
- rent = estimated monthly market rent (integer)
- carry = estimated monthly financing cost at 8% hard money (integer)
- Use real comparable data for the zip code
- Return ONLY the JSON object, nothing else

Property: ${address}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 800,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 200)}`);
    }

    const data = await res.json();
    let raw = data.content[0].text.trim()
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim();

    const parsed = JSON.parse(raw);

    // Build photo URLs if missing
    const enc = encodeURIComponent(parsed.address || address);
    if (!parsed.zillow) parsed.zillow = `https://www.zillow.com/homes/${enc}_rb/`;
    if (!parsed.redfin) parsed.redfin = `https://www.redfin.com/search?location=${enc}`;
    if (!parsed.trulia) parsed.trulia = `https://www.trulia.com/homes/${enc.replace(/%20/g, "_")}/`;

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*"
      },
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    console.error("Function error:", err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
};
