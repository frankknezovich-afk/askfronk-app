exports.handler = async function (event) {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: JSON.stringify({ error: "Method not allowed" }) };
  }

  let address;
  try {
    const body = JSON.parse(event.body || "{}");
    address = body.address;
    if (!address) throw new Error("missing address");
  } catch (e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid request body" }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }) };
  }

  // ── STEP 1: Geocode address ─────────────────────────────────────────────────
  let publicData = {};
  try {
    const geoUrl = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
    const geoRes = await fetch(geoUrl, { headers: { "User-Agent": "AskFronkApp/1.0", "Accept-Language": "en" } });
    if (geoRes.ok) {
      const geoData = await geoRes.json();
      if (geoData && geoData[0]) {
        const g = geoData[0], a = g.address || {};
        publicData.lat = parseFloat(g.lat);
        publicData.lon = parseFloat(g.lon);
        publicData.zip = a.postcode || "";
        publicData.city = a.city || a.town || a.village || "";
        publicData.county = a.county || "";
        publicData.displayAddress = [
          ((a.house_number||"") + " " + (a.road||"")).trim(),
          a.city || a.town || a.village || "",
          a.state || "PA",
          a.postcode || ""
        ].filter(Boolean).join(", ");
      }
    }
  } catch (e) { console.log("Geocode fail:", e.message); }

  // ── STEP 2: Allegheny County property record ────────────────────────────────
  let lastSaleData = {};
  try {
    const houseNum = address.match(/^\d+/)?.[0] || "";
    const streetRaw = address.replace(/^\d+\s+/, "").split(",")[0].trim();
    const acUrl = `https://data.wprdc.org/api/3/action/datastore_search?resource_id=f2b8d575-4f4f-4e92-bd43-2d2765d28d56&q=${encodeURIComponent(houseNum + " " + streetRaw)}&limit=3`;
    const acRes = await fetch(acUrl, { headers: { "User-Agent": "AskFronkApp/1.0" } });
    if (acRes.ok) {
      const acData = await acRes.json();
      const records = acData?.result?.records || [];
      if (records.length > 0) {
        const r = records[0];
        lastSaleData = {
          lastSalePrice:   parseInt(r.SALEPRICE || 0),
          lastSaleDate:    r.SALEDATE || "",
          fairMarketValue: parseInt(r.FAIRMARKETTOTAL || 0),
          landValue:       parseInt(r.FAIRMARKETLAND || 0),
          buildingValue:   parseInt(r.FAIRMARKETBUILDING || 0),
          sqft:            r.FINISHEDLIVINGAREA || "",
          bedrooms:        r.BEDROOMS || "",
          bathrooms:       r.FULLBATHS || "",
          halfBaths:       r.HALFBATHS || "",
          yearBuilt:       r.YEARBLT || "",
          condition:       r.CDU || "",
          grade:           r.GRADE || "",
          style:           r.STYLE || "",
          lotArea:         r.LOTAREA || "",
          taxCode:         r.CLASSDESC || "",
          source:          "Allegheny County Assessment (WPRDC)"
        };
      }
    }
  } catch (e) { console.log("AC lookup fail:", e.message); }

  // ── STEP 3: Recent comp sales in same ZIP ───────────────────────────────────
  let compSales = [];
  if (publicData.zip) {
    try {
      const sql = `SELECT "SALEDATE","SALEPRICE","PROPERTYHOUSENUM","PROPERTYADDRESS","FINISHEDLIVINGAREA","BEDROOMS","FULLBATHS" FROM "f2b8d575-4f4f-4e92-bd43-2d2765d28d56" WHERE "PROPERTYZIP"='${publicData.zip}' AND "SALEPRICE">'20000' AND "SALEPRICE"<'600000' ORDER BY "SALEDATE" DESC LIMIT 8`;
      const compUrl = `https://data.wprdc.org/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sql)}`;
      const compRes = await fetch(compUrl, { headers: { "User-Agent": "AskFronkApp/1.0" } });
      if (compRes.ok) {
        const compData = await compRes.json();
        compSales = (compData?.result?.records || []).slice(0, 6).map(r => ({
          address:   `${r.PROPERTYHOUSENUM||""} ${r.PROPERTYADDRESS||""}`.trim(),
          salePrice: parseInt(r.SALEPRICE || 0),
          saleDate:  r.SALEDATE || "",
          sqft:      r.FINISHEDLIVINGAREA || "",
          beds:      r.BEDROOMS || "",
          baths:     r.FULLBATHS || ""
        })).filter(r => r.salePrice > 0);
      }
    } catch (e) { console.log("Comp sales fail:", e.message); }
  }

  // ── STEP 4: Build context for Claude ───────────────────────────────────────
  let dataContext = `\nINPUT ADDRESS: ${address}\n`;

  if (publicData.displayAddress) {
    dataContext += `Geocoded: ${publicData.displayAddress} | ZIP: ${publicData.zip} | County: ${publicData.county}\n`;
  }

  if (lastSaleData.lastSalePrice > 0) {
    dataContext += `
REAL PROPERTY RECORD — ${lastSaleData.source}:
• Last Sale Price:    $${lastSaleData.lastSalePrice.toLocaleString()} on ${lastSaleData.lastSaleDate || "date unknown"}
• Fair Market Value:  $${lastSaleData.fairMarketValue?.toLocaleString() || "unknown"} (assessed)
• Building Value:     $${lastSaleData.buildingValue?.toLocaleString() || "unknown"}
• Land Value:         $${lastSaleData.landValue?.toLocaleString() || "unknown"}
• Living Area:        ${lastSaleData.sqft || "unknown"} sqft
• Bedrooms/Baths:     ${lastSaleData.bedrooms || "?"} bed / ${lastSaleData.bathrooms || "?"}+${lastSaleData.halfBaths || "0"} bath
• Year Built:         ${lastSaleData.yearBuilt || "unknown"}
• Condition (CDU):    ${lastSaleData.condition || "unknown"}
• Grade:              ${lastSaleData.grade || "unknown"}
• Style:              ${lastSaleData.style || "unknown"}
• Lot Area:           ${lastSaleData.lotArea || "unknown"} sqft
• Tax Class:          ${lastSaleData.taxCode || "unknown"}`;
  } else {
    dataContext += `\nNo public record found — estimate based on neighborhood comps.\n`;
  }

  if (compSales.length > 0) {
    const avgComp = Math.round(compSales.reduce((s, c) => s + c.salePrice, 0) / compSales.length);
    dataContext += `\n\nRECENT SALES IN ZIP ${publicData.zip} (avg: $${avgComp.toLocaleString()}):`;
    compSales.forEach((c, i) => {
      dataContext += `\n  ${i+1}. ${c.address} — $${c.salePrice.toLocaleString()} (${c.saleDate || "?"})${c.sqft ? " | "+c.sqft+" sqft" : ""}${c.beds ? " | "+c.beds+"bd/"+c.baths+"ba" : ""}`;
    });
  }

  // ── STEP 5: Claude analysis with real data ──────────────────────────────────
  const prompt = `You are a real estate investment analyst specializing in Pennsylvania fix-and-flip properties.

Use the REAL property data below to analyze this deal for an investor. Return ONLY a valid JSON object — no markdown, no code fences.
${dataContext}

Return this exact JSON structure:
{
  "address": "full formatted address string",
  "beds": "e.g. 3 bed / 1 bath",
  "sqft": "e.g. 1,200 sqft",
  "year": "e.g. Built 1965",
  "type": "e.g. Single Family",
  "county": "e.g. Allegheny County",
  "last_sale_price": integer (use real data above, 0 if unknown),
  "last_sale_date": "YYYY-MM-DD string or empty",
  "assessed_value": integer (fair market value from record, 0 if unknown),
  "acq": integer — realistic sheriff/auction bid price TODAY,
  "arv": integer — after repair value anchored to the comp sales above,
  "rehab": integer — full renovation cost × 2 conservative buffer,
  "rent": integer — monthly market rent for this zip/property type,
  "notes": "2-3 sentences using REAL data. Must mention: (1) last sale price and date, (2) how comps inform ARV, (3) one specific investor risk or opportunity for this property.",
  "zillow": "https://www.zillow.com/homes/ENCODED_rb/",
  "redfin": "https://www.redfin.com/search?location=ENCODED",
  "trulia": "https://www.trulia.com/p/pa/CITY/STREET/"
}

ANALYSIS RULES:
- acq = distressed acquisition price, typically 40-70% of ARV for sheriff sales
- arv = use average of comp sales + adjustment for condition/beds/sqft
- rehab = estimate full gut renovation then multiply × 2 for conservative buffer
- If last sale was recent (< 3 years) at market value, note that seller paid near market
- If assessed value >> last sale price, flag as potential tax savings
- If comp avg is higher than last sale, highlight the upside
- Return ONLY the JSON`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }]
      })
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`Anthropic ${res.status}: ${txt.slice(0, 300)}`);
    }

    const data = await res.json();
    let raw = data.content[0].text.trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();

    const parsed = JSON.parse(raw);

    // Always attach real data directly
    if (lastSaleData.lastSalePrice > 0) {
      parsed.last_sale_price = lastSaleData.lastSalePrice;
      parsed.last_sale_date  = lastSaleData.lastSaleDate;
      parsed.assessed_value  = lastSaleData.fairMarketValue;
      parsed.sqft_actual     = lastSaleData.sqft;
      parsed.year_actual     = lastSaleData.yearBuilt;
      parsed.condition       = lastSaleData.condition;
      parsed.data_source     = lastSaleData.source;
    }
    if (compSales.length > 0) {
      parsed.comps = compSales;
      parsed.comp_avg = Math.round(compSales.reduce((s, c) => s + c.salePrice, 0) / compSales.length);
    }

    const enc = encodeURIComponent(parsed.address || address);
    if (!parsed.zillow) parsed.zillow = `https://www.zillow.com/homes/${enc}_rb/`;
    if (!parsed.redfin) parsed.redfin = `https://www.redfin.com/search?location=${enc}`;
    if (!parsed.trulia) parsed.trulia = `https://www.trulia.com/homes/${enc.replace(/%20/g, "_")}/`;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(parsed)
    };

  } catch (err) {
    console.error("Function error:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
