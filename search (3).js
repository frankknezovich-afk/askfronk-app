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

  // ── STEP 1: Geocode via Nominatim ───────────────────────────────────────────
  let geo = {};
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=${encodeURIComponent(address)}`;
    const r = await fetch(url, { headers: { "User-Agent": "AskFronkApp/1.0", "Accept-Language": "en" } });
    if (r.ok) {
      const d = await r.json();
      if (d && d[0]) {
        const g = d[0], a = g.address || {};
        geo = {
          lat: g.lat, lon: g.lon,
          zip: a.postcode || "",
          city: a.city || a.town || a.village || a.municipality || "",
          county: (a.county || "").replace(" County",""),
          state: a.state || "PA",
          houseNum: a.house_number || "",
          road: a.road || "",
          display: [
            ((a.house_number||"")+" "+(a.road||"")).trim(),
            a.city || a.town || a.village || "",
            a.state || "PA",
            a.postcode || ""
          ].filter(Boolean).join(", ")
        };
      }
    }
  } catch(e) { console.log("Geocode fail:", e.message); }

  // ── STEP 2: WPRDC Property API — best source for Allegheny parcel data ──────
  let parcel = {};
  let compSales = [];

  try {
    // Search assessments table by house number + street name
    const hnum = address.match(/^\d+/)?.[0] || geo.houseNum || "";
    const street = address.replace(/^\d+\s+/, "").split(",")[0].replace(/\b(st|ave|rd|dr|blvd|ln|ct|pl|way|ter|terr|circle|cir)\b\.?/gi, "").trim().toUpperCase();

    // Assessment dataset resource ID
    const assessRes = "518b583f-7cc8-4f60-94d0-174cc98310dc";
    const sqlAssess = `SELECT * FROM "${assessRes}" WHERE "PROPERTYHOUSENUM"='${hnum}' AND "PROPERTYADDRESS" LIKE '${street.split(" ")[0]}%' LIMIT 5`;
    const assessUrl = `https://data.wprdc.org/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sqlAssess)}`;

    const aRes = await fetch(assessUrl, { headers: { "User-Agent": "AskFronkApp/1.0" } });
    if (aRes.ok) {
      const aData = await aRes.json();
      const recs = aData?.result?.records || [];
      if (recs.length > 0) {
        const r = recs[0];
        parcel = {
          parid:          r.PARID || "",
          houseNum:       r.PROPERTYHOUSENUM || "",
          streetName:     r.PROPERTYADDRESS || "",
          city:           r.PROPERTYCITY || "",
          zip:            r.PROPERTYZIP || "",
          owner:          r.CHANGENOTICEADDRESS1 || "",
          fairMktTotal:   Math.round(parseFloat(r.FAIRMARKETTOTAL || 0)),
          fairMktBldg:    Math.round(parseFloat(r.FAIRMARKETBUILDING || 0)),
          fairMktLand:    Math.round(parseFloat(r.FAIRMARKETLAND || 0)),
          lastSalePrice:  Math.round(parseFloat(r.SALEPRICE || 0)),
          lastSaleDate:   r.SALEDATE || "",
          lastSaleDesc:   r.SALEDESC || "",
          sqft:           r.FINISHEDLIVINGAREA || "",
          lotArea:        r.LOTAREA || "",
          bedrooms:       r.BEDROOMS || "",
          fullBaths:      r.FULLBATHS || "",
          halfBaths:      r.HALFBATHS || "",
          yearBuilt:      r.YEARBLT || "",
          condition:      r.CDU || "",
          conditionDesc:  r.CDUDESC || "",
          grade:          r.GRADE || "",
          gradeDesc:      r.GRADEDESC || "",
          style:          r.STYLE || "",
          styleDesc:      r.STYLEDESC || "",
          stories:        r.STORIES || "",
          extFinish:      r.EXTFINISH_DESC || "",
          roof:           r.ROOF || "",
          basement:       r.BASEMENT || "",
          heat:           r.HEATINGCOOLINGDESC || "",
          taxCode:        r.TAXDESC || "",
          schoolDist:     r.SCHOOLDESC || "",
          municipality:   r.MUNICDESC || "",
          source:         "Allegheny County Assessment Database"
        };
      }
    }
  } catch(e) { console.log("Assessment lookup fail:", e.message); }

  // ── STEP 3: Recent sales in same ZIP ───────────────────────────────────────
  const zipForComps = parcel.zip || geo.zip;
  if (zipForComps) {
    try {
      const salesRes = "518b583f-7cc8-4f60-94d0-174cc98310dc";
      const sqlComps = `SELECT "PROPERTYHOUSENUM","PROPERTYADDRESS","PROPERTYCITY","SALEPRICE","SALEDATE","SALEDESC","FINISHEDLIVINGAREA","BEDROOMS","FULLBATHS","FAIRMARKETTOTAL" FROM "${salesRes}" WHERE "PROPERTYZIP"='${zipForComps}' AND CAST("SALEPRICE" AS FLOAT)>15000 AND CAST("SALEPRICE" AS FLOAT)<700000 AND "SALEDESC" NOT LIKE '%MULTI%' ORDER BY "SALEDATE" DESC LIMIT 10`;
      const cUrl = `https://data.wprdc.org/api/3/action/datastore_search_sql?sql=${encodeURIComponent(sqlComps)}`;
      const cRes = await fetch(cUrl, { headers: { "User-Agent": "AskFronkApp/1.0" } });
      if (cRes.ok) {
        const cData = await cRes.json();
        compSales = (cData?.result?.records || [])
          .map(r => ({
            address:   `${r.PROPERTYHOUSENUM||""} ${r.PROPERTYADDRESS||""}`.trim(),
            city:      r.PROPERTYCITY || "",
            salePrice: Math.round(parseFloat(r.SALEPRICE || 0)),
            saleDate:  r.SALEDATE || "",
            saleDesc:  r.SALEDESC || "",
            sqft:      r.FINISHEDLIVINGAREA || "",
            beds:      r.BEDROOMS || "",
            baths:     r.FULLBATHS || "",
            assessed:  Math.round(parseFloat(r.FAIRMARKETTOTAL || 0))
          }))
          .filter(r => r.salePrice > 0)
          .slice(0, 8);
      }
    } catch(e) { console.log("Comp sales fail:", e.message); }
  }

  // ── STEP 4: Build rich context for Claude ───────────────────────────────────
  let ctx = `INPUT ADDRESS: ${address}\n`;

  if (geo.display) {
    ctx += `Geocoded: ${geo.display}\n`;
  }

  if (parcel.sqft) {
    ctx += `
=== REAL PROPERTY RECORD (${parcel.source}) ===
Address:         ${parcel.houseNum} ${parcel.streetName}, ${parcel.city} PA ${parcel.zip}
Parcel ID:       ${parcel.parid}
Municipality:    ${parcel.municipality} | School District: ${parcel.schoolDist}
Tax Status:      ${parcel.taxCode}

LAST SALE:
  Price:         $${parcel.lastSalePrice > 0 ? parcel.lastSalePrice.toLocaleString() : "No sale recorded"}
  Date:          ${parcel.lastSaleDate || "Unknown"}
  Type:          ${parcel.lastSaleDesc || "Unknown"}

ASSESSED VALUES:
  Total FMV:     $${parcel.fairMktTotal.toLocaleString()}
  Building:      $${parcel.fairMktBldg.toLocaleString()}
  Land:          $${parcel.fairMktLand.toLocaleString()}

PHYSICAL DETAILS:
  Living Area:   ${parcel.sqft} sqft
  Lot:           ${parcel.lotArea} sqft
  Bedrooms:      ${parcel.bedrooms} | Full Baths: ${parcel.fullBaths} | Half: ${parcel.halfBaths}
  Year Built:    ${parcel.yearBuilt}
  Stories:       ${parcel.stories}
  Style:         ${parcel.styleDesc || parcel.style}
  Condition:     ${parcel.conditionDesc || parcel.condition} (CDU grade)
  Quality Grade: ${parcel.gradeDesc || parcel.grade}
  Exterior:      ${parcel.extFinish}
  Roof:          ${parcel.roof}
  Basement:      ${parcel.basement}
  Heating/AC:    ${parcel.heat}`;
  } else {
    ctx += `\nNo assessment record found in Allegheny County database. Estimate from market knowledge.\n`;
  }

  if (compSales.length > 0) {
    const validSales = compSales.filter(c => c.salePrice > 0);
    const avgSale = validSales.length > 0
      ? Math.round(validSales.reduce((s, c) => s + c.salePrice, 0) / validSales.length)
      : 0;
    const medSale = validSales.length > 0
      ? validSales.map(c => c.salePrice).sort((a,b) => a-b)[Math.floor(validSales.length/2)]
      : 0;

    ctx += `\n\n=== RECENT COMPARABLE SALES — ZIP ${zipForComps} ===`;
    ctx += `\nAverage sale: $${avgSale.toLocaleString()} | Median: $${medSale.toLocaleString()} | Count: ${validSales.length}`;
    compSales.forEach((c, i) => {
      ctx += `\n  ${i+1}. ${c.address}${c.city?" ("+c.city+")":""} — $${c.salePrice.toLocaleString()} on ${c.saleDate||"?"}${c.sqft?" | "+c.sqft+" sqft":""}${c.beds?" | "+c.beds+"bd/"+c.baths+"ba":""}`;
    });
  } else {
    ctx += `\n\nNo comparable sales data found for ZIP ${zipForComps}.`;
  }

  // ── STEP 5: Claude analysis ─────────────────────────────────────────────────
  const avgCompPrice = compSales.length > 0
    ? Math.round(compSales.reduce((s, c) => s + c.salePrice, 0) / compSales.length)
    : 0;

  const prompt = `You are a real estate investment analyst specializing in Pennsylvania fix-and-flip properties.

Use the REAL property data below to produce a deal analysis for an investor. Return ONLY a valid JSON object — no markdown, no code fences, no extra text.

${ctx}

Return this exact JSON:
{
  "address": "formatted address string",
  "beds": "${parcel.bedrooms ? parcel.bedrooms+" bed / "+parcel.fullBaths+" bath" : "e.g. 3 bed / 1 bath"}",
  "sqft": "${parcel.sqft ? parcel.sqft+" sqft" : "e.g. 1,200 sqft"}",
  "year": "${parcel.yearBuilt ? "Built "+parcel.yearBuilt : "e.g. Built 1960"}",
  "type": "${parcel.styleDesc || parcel.style || "Single Family"}",
  "county": "${parcel.municipality ? parcel.municipality+", "+geo.county+" County" : geo.county+" County" || "Allegheny County"}",
  "last_sale_price": ${parcel.lastSalePrice || 0},
  "last_sale_date": "${parcel.lastSaleDate || ""}",
  "assessed_value": ${parcel.fairMktTotal || 0},
  "acq": integer — realistic sheriff/auction distressed acquisition price based on assessed value and condition,
  "arv": integer — after repair value anchored to the comp sales median/average above,
  "rehab": integer — full renovation estimate for this property's condition and sqft, then doubled for conservative buffer,
  "rent": integer — monthly market rent for this zip/property type/size,
  "notes": "3 sentences REQUIRED: (1) State the last sale price and date and what it means — e.g. sold at X in Y, which is Z% below/above current comps. (2) State how comps inform the ARV. (3) Note the condition grade and one specific risk or opportunity.",
  "zillow": "https://www.zillow.com/homes/${encodeURIComponent((parcel.houseNum||"")+" "+(parcel.streetName||address))}-PA-${parcel.zip||geo.zip||""}_rb/",
  "redfin": "https://www.redfin.com/search?location=${encodeURIComponent(address)}",
  "trulia": "https://www.trulia.com/p/pa/${(geo.city||"pittsburgh").toLowerCase().replace(/ /g,"-")}/${((parcel.houseNum||"")+" "+(parcel.streetName||"")).trim().toLowerCase().replace(/ /g,"-")}-${parcel.zip||geo.zip||}/"
}

CALCULATION RULES:
- acq = distressed/sheriff sale price. Use assessed value as anchor. Typical sheriff sale = 40-65% of ARV.
- arv = use comp median as primary anchor, then adjust ±10% for condition (CDU grade), sqft difference, and beds/baths vs comps
- rehab: estimate realistic full renovation cost for condition "${parcel.conditionDesc||parcel.condition||"unknown"}" then × 2 conservative buffer
- If last_sale_price > 0 and it was recent (< 3 yrs), the seller bought at market — note this as risk
- If assessed_value is significantly below comp average, flag as potential tax opportunity
- Return ONLY valid JSON`;

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

    // Always override with real data
    if (parcel.lastSalePrice > 0)  parsed.last_sale_price = parcel.lastSalePrice;
    if (parcel.lastSaleDate)        parsed.last_sale_date  = parcel.lastSaleDate;
    if (parcel.fairMktTotal > 0)    parsed.assessed_value  = parcel.fairMktTotal;
    if (parcel.sqft)                parsed.sqft_actual     = parcel.sqft;
    if (parcel.yearBuilt)           parsed.year_actual     = parcel.yearBuilt;
    if (parcel.condition)           parsed.condition       = parcel.conditionDesc || parcel.condition;
    if (parcel.grade)               parsed.grade           = parcel.gradeDesc || parcel.grade;
    if (parcel.parid)               parsed.parid           = parcel.parid;
    if (parcel.source)              parsed.data_source     = parcel.source;

    if (compSales.length > 0) {
      parsed.comps = compSales;
      parsed.comp_avg = avgCompPrice;
      parsed.comp_count = compSales.length;
    }

    // Build photo URLs
    const enc = encodeURIComponent(parsed.address || address);
    if (!parsed.zillow || parsed.zillow.includes("undefined")) {
      parsed.zillow = `https://www.zillow.com/homes/${enc}_rb/`;
    }
    if (!parsed.redfin) parsed.redfin = `https://www.redfin.com/search?location=${enc}`;
    if (!parsed.trulia || parsed.trulia.includes("undefined")) {
      parsed.trulia = `https://www.trulia.com/homes/${enc.replace(/%20/g,"_")}/`;
    }

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
