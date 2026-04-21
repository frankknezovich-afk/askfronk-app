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

  // ── STEP 1: Geocode ─────────────────────────────────────────────────────────
  let geo = { zip: "", city: "", county: "", state: "PA", houseNum: "", road: "", display: "" };
  try {
    const geoUrl = "https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=us&q=" + encodeURIComponent(address);
    const geoRes = await fetch(geoUrl, { headers: { "User-Agent": "AskFronkApp/1.0", "Accept-Language": "en" } });
    if (geoRes.ok) {
      const gd = await geoRes.json();
      if (gd && gd[0]) {
        const g = gd[0];
        const a = g.address || {};
        geo.zip      = a.postcode || "";
        geo.city     = a.city || a.town || a.village || a.municipality || "";
        geo.county   = (a.county || "").replace(" County", "");
        geo.state    = a.state || "PA";
        geo.houseNum = a.house_number || "";
        geo.road     = a.road || "";
        geo.display  = [
          ((a.house_number || "") + " " + (a.road || "")).trim(),
          geo.city, geo.state, geo.zip
        ].filter(Boolean).join(", ");
      }
    }
  } catch (e) { console.log("Geocode fail:", e.message); }

  // ── STEP 2: Allegheny County assessment lookup ──────────────────────────────
  let parcel = {
    parid: "", houseNum: "", streetName: "", city: "", zip: "",
    fairMktTotal: 0, fairMktBldg: 0, fairMktLand: 0,
    lastSalePrice: 0, lastSaleDate: "", lastSaleDesc: "",
    sqft: "", lotArea: "", bedrooms: "", fullBaths: "", halfBaths: "",
    yearBuilt: "", condition: "", conditionDesc: "", grade: "", gradeDesc: "",
    style: "", styleDesc: "", stories: "", extFinish: "", roof: "",
    basement: "", heat: "", taxCode: "", schoolDist: "", municipality: "",
    source: ""
  };

  try {
    const hnum   = (address.match(/^\d+/) || [""])[0] || geo.houseNum;
    const street = address.replace(/^\d+\s+/, "").split(",")[0].trim().toUpperCase().split(" ")[0];
    const rid    = "518b583f-7cc8-4f60-94d0-174cc98310dc";
    const sql    = 'SELECT * FROM "' + rid + '" WHERE "PROPERTYHOUSENUM"=\'' + hnum + '\' AND "PROPERTYADDRESS" LIKE \'' + street + '%\' LIMIT 5';
    const aUrl   = "https://data.wprdc.org/api/3/action/datastore_search_sql?sql=" + encodeURIComponent(sql);
    const aRes   = await fetch(aUrl, { headers: { "User-Agent": "AskFronkApp/1.0" } });
    if (aRes.ok) {
      const aData = await aRes.json();
      const recs  = (aData && aData.result && aData.result.records) ? aData.result.records : [];
      if (recs.length > 0) {
        const r = recs[0];
        parcel.parid          = r.PARID || "";
        parcel.houseNum       = r.PROPERTYHOUSENUM || "";
        parcel.streetName     = r.PROPERTYADDRESS || "";
        parcel.city           = r.PROPERTYCITY || "";
        parcel.zip            = r.PROPERTYZIP || "";
        parcel.fairMktTotal   = Math.round(parseFloat(r.FAIRMARKETTOTAL || 0));
        parcel.fairMktBldg    = Math.round(parseFloat(r.FAIRMARKETBUILDING || 0));
        parcel.fairMktLand    = Math.round(parseFloat(r.FAIRMARKETLAND || 0));
        parcel.lastSalePrice  = Math.round(parseFloat(r.SALEPRICE || 0));
        parcel.lastSaleDate   = r.SALEDATE || "";
        parcel.lastSaleDesc   = r.SALEDESC || "";
        parcel.sqft           = r.FINISHEDLIVINGAREA || "";
        parcel.lotArea        = r.LOTAREA || "";
        parcel.bedrooms       = r.BEDROOMS || "";
        parcel.fullBaths      = r.FULLBATHS || "";
        parcel.halfBaths      = r.HALFBATHS || "";
        parcel.yearBuilt      = r.YEARBLT || "";
        parcel.condition      = r.CDU || "";
        parcel.conditionDesc  = r.CDUDESC || "";
        parcel.grade          = r.GRADE || "";
        parcel.gradeDesc      = r.GRADEDESC || "";
        parcel.style          = r.STYLE || "";
        parcel.styleDesc      = r.STYLEDESC || "";
        parcel.stories        = r.STORIES || "";
        parcel.extFinish      = r.EXTFINISH_DESC || "";
        parcel.roof           = r.ROOF || "";
        parcel.basement       = r.BASEMENT || "";
        parcel.heat           = r.HEATINGCOOLINGDESC || "";
        parcel.taxCode        = r.TAXDESC || "";
        parcel.schoolDist     = r.SCHOOLDESC || "";
        parcel.municipality   = r.MUNICDESC || "";
        parcel.source         = "Allegheny County Assessment Database";
      }
    }
  } catch (e) { console.log("Assessment fail:", e.message); }

  // ── STEP 3: Comp sales in same ZIP ──────────────────────────────────────────
  let compSales = [];
  const zipForComps = parcel.zip || geo.zip;

  if (zipForComps) {
    try {
      const rid2   = "518b583f-7cc8-4f60-94d0-174cc98310dc";
      const sql2   = 'SELECT "PROPERTYHOUSENUM","PROPERTYADDRESS","PROPERTYCITY","SALEPRICE","SALEDATE","SALEDESC","FINISHEDLIVINGAREA","BEDROOMS","FULLBATHS","FAIRMARKETTOTAL" FROM "' + rid2 + '" WHERE "PROPERTYZIP"=\'' + zipForComps + '\' AND CAST("SALEPRICE" AS FLOAT)>15000 AND CAST("SALEPRICE" AS FLOAT)<700000 ORDER BY "SALEDATE" DESC LIMIT 10';
      const cUrl   = "https://data.wprdc.org/api/3/action/datastore_search_sql?sql=" + encodeURIComponent(sql2);
      const cRes   = await fetch(cUrl, { headers: { "User-Agent": "AskFronkApp/1.0" } });
      if (cRes.ok) {
        const cData = await cRes.json();
        const recs  = (cData && cData.result && cData.result.records) ? cData.result.records : [];
        compSales = recs
          .map(function(r) {
            return {
              address:   ((r.PROPERTYHOUSENUM || "") + " " + (r.PROPERTYADDRESS || "")).trim(),
              city:      r.PROPERTYCITY || "",
              salePrice: Math.round(parseFloat(r.SALEPRICE || 0)),
              saleDate:  r.SALEDATE || "",
              saleDesc:  r.SALEDESC || "",
              sqft:      r.FINISHEDLIVINGAREA || "",
              beds:      r.BEDROOMS || "",
              baths:     r.FULLBATHS || "",
              assessed:  Math.round(parseFloat(r.FAIRMARKETTOTAL || 0))
            };
          })
          .filter(function(r) { return r.salePrice > 0; })
          .slice(0, 8);
      }
    } catch (e) { console.log("Comp sales fail:", e.message); }
  }

  // ── STEP 4: Build context string ────────────────────────────────────────────
  var avgComp = 0;
  var medComp = 0;
  if (compSales.length > 0) {
    avgComp = Math.round(compSales.reduce(function(s, c) { return s + c.salePrice; }, 0) / compSales.length);
    var sorted = compSales.map(function(c) { return c.salePrice; }).sort(function(a, b) { return a - b; });
    medComp = sorted[Math.floor(sorted.length / 2)];
  }

  var ctx = "INPUT ADDRESS: " + address + "\n";
  if (geo.display) ctx += "Geocoded: " + geo.display + "\n";

  if (parcel.sqft) {
    ctx += "\n=== REAL PROPERTY RECORD (" + parcel.source + ") ===\n";
    ctx += "Address: " + parcel.houseNum + " " + parcel.streetName + ", " + parcel.city + " PA " + parcel.zip + "\n";
    ctx += "Parcel ID: " + parcel.parid + " | Municipality: " + parcel.municipality + " | School: " + parcel.schoolDist + "\n";
    ctx += "\nLAST SALE:\n";
    ctx += "  Price: $" + (parcel.lastSalePrice > 0 ? parcel.lastSalePrice.toLocaleString() : "No sale on record") + "\n";
    ctx += "  Date:  " + (parcel.lastSaleDate || "Unknown") + "\n";
    ctx += "  Type:  " + (parcel.lastSaleDesc || "Unknown") + "\n";
    ctx += "\nASSESSED VALUES:\n";
    ctx += "  Total FMV:  $" + parcel.fairMktTotal.toLocaleString() + "\n";
    ctx += "  Building:   $" + parcel.fairMktBldg.toLocaleString() + "\n";
    ctx += "  Land:       $" + parcel.fairMktLand.toLocaleString() + "\n";
    ctx += "\nPROPERTY DETAILS:\n";
    ctx += "  Living Area: " + parcel.sqft + " sqft | Lot: " + parcel.lotArea + " sqft\n";
    ctx += "  Beds/Baths:  " + parcel.bedrooms + " bed / " + parcel.fullBaths + " full + " + parcel.halfBaths + " half bath\n";
    ctx += "  Year Built:  " + parcel.yearBuilt + " | Stories: " + parcel.stories + "\n";
    ctx += "  Style:       " + (parcel.styleDesc || parcel.style) + "\n";
    ctx += "  Condition:   " + (parcel.conditionDesc || parcel.condition) + " (CDU)\n";
    ctx += "  Grade:       " + (parcel.gradeDesc || parcel.grade) + "\n";
    ctx += "  Exterior:    " + parcel.extFinish + " | Roof: " + parcel.roof + "\n";
    ctx += "  Basement:    " + parcel.basement + " | Heat: " + parcel.heat + "\n";
  } else {
    ctx += "\nNo assessment record found. Estimate from neighborhood knowledge.\n";
  }

  if (compSales.length > 0) {
    ctx += "\n=== COMP SALES — ZIP " + zipForComps + " ===\n";
    ctx += "Average: $" + avgComp.toLocaleString() + " | Median: $" + medComp.toLocaleString() + " | Count: " + compSales.length + "\n";
    compSales.forEach(function(c, i) {
      ctx += (i + 1) + ". " + c.address + (c.city ? " (" + c.city + ")" : "") +
             " — $" + c.salePrice.toLocaleString() +
             " on " + (c.saleDate || "?") +
             (c.sqft ? " | " + c.sqft + " sqft" : "") +
             (c.beds ? " | " + c.beds + "bd/" + c.baths + "ba" : "") + "\n";
    });
  }

  // ── STEP 5: Claude with real data ───────────────────────────────────────────
  var bedsStr    = parcel.bedrooms ? (parcel.bedrooms + " bed / " + parcel.fullBaths + " bath") : "e.g. 3 bed / 1 bath";
  var sqftStr    = parcel.sqft ? (parcel.sqft + " sqft") : "e.g. 1,200 sqft";
  var yearStr    = parcel.yearBuilt ? ("Built " + parcel.yearBuilt) : "e.g. Built 1960";
  var typeStr    = parcel.styleDesc || parcel.style || "Single Family";
  var countyStr  = parcel.municipality ? (parcel.municipality + ", " + (geo.county || "Allegheny") + " County") : ((geo.county || "Allegheny") + " County");
  var zipStr     = parcel.zip || geo.zip || "";
  var enc        = encodeURIComponent(address);
  var zillowUrl  = "https://www.zillow.com/homes/" + enc + "_rb/";
  var redfin     = "https://www.redfin.com/search?location=" + enc;
  var trulia     = "https://www.trulia.com/homes/" + enc.replace(/%20/g, "_") + "/";
  var condStr    = parcel.conditionDesc || parcel.condition || "unknown";

  const prompt = "You are a real estate investment analyst for Pennsylvania fix-and-flip properties.\n\n" +
    "Use the REAL property data below. Return ONLY a valid JSON object — no markdown, no code fences.\n\n" +
    ctx +
    "\nReturn this exact JSON structure:\n" +
    "{\n" +
    '  "address": "' + (parcel.houseNum ? parcel.houseNum + " " + parcel.streetName + ", " + parcel.city + " PA " + zipStr : address) + '",\n' +
    '  "beds": "' + bedsStr + '",\n' +
    '  "sqft": "' + sqftStr + '",\n' +
    '  "year": "' + yearStr + '",\n' +
    '  "type": "' + typeStr + '",\n' +
    '  "county": "' + countyStr + '",\n' +
    '  "last_sale_price": ' + (parcel.lastSalePrice || 0) + ',\n' +
    '  "last_sale_date": "' + (parcel.lastSaleDate || "") + '",\n' +
    '  "assessed_value": ' + (parcel.fairMktTotal || 0) + ',\n' +
    '  "acq": <integer: realistic sheriff/auction price, anchor to assessed value, typically 40-65% of ARV>,\n' +
    '  "arv": <integer: after repair value, use comp median $' + medComp.toLocaleString() + ' as anchor, adjust for condition and sqft>,\n' +
    '  "rehab": <integer: full renovation cost for condition "' + condStr + '" and ' + (parcel.sqft || "unknown") + ' sqft, then doubled>,\n' +
    '  "rent": <integer: monthly market rent for this zip and property type>,\n' +
    '  "notes": "<3 sentences: (1) last sale $' + (parcel.lastSalePrice > 0 ? parcel.lastSalePrice.toLocaleString() : "unknown") + ' on ' + (parcel.lastSaleDate || "unknown") + ' vs comp avg $' + avgComp.toLocaleString() + ' — what does this mean for the deal? (2) how do the comps set the ARV? (3) condition grade ' + condStr + ' — specific rehab risk or opportunity>",\n' +
    '  "zillow": "' + zillowUrl + '",\n' +
    '  "redfin": "' + redfin + '",\n' +
    '  "trulia": "' + trulia + '"\n' +
    "}\n\n" +
    "RULES: Return ONLY valid JSON. No explanation. No markdown.";

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
      throw new Error("Anthropic " + res.status + ": " + txt.slice(0, 200));
    }

    const data = await res.json();
    let raw = data.content[0].text.trim()
      .replace(/^```json\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim();

    const parsed = JSON.parse(raw);

    // Always override with verified real data
    if (parcel.lastSalePrice > 0) {
      parsed.last_sale_price = parcel.lastSalePrice;
      parsed.last_sale_date  = parcel.lastSaleDate;
    }
    if (parcel.fairMktTotal > 0)  parsed.assessed_value = parcel.fairMktTotal;
    if (parcel.sqft)               parsed.sqft_actual    = parcel.sqft;
    if (parcel.yearBuilt)          parsed.year_actual    = parcel.yearBuilt;
    if (parcel.conditionDesc || parcel.condition) parsed.condition = parcel.conditionDesc || parcel.condition;
    if (parcel.gradeDesc || parcel.grade)         parsed.grade     = parcel.gradeDesc || parcel.grade;
    if (parcel.parid)              parsed.parid          = parcel.parid;
    if (parcel.source)             parsed.data_source    = parcel.source;

    if (compSales.length > 0) {
      parsed.comps      = compSales;
      parsed.comp_avg   = avgComp;
      parsed.comp_count = compSales.length;
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
