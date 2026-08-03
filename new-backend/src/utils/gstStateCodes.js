// GST state codes, keyed by 2-digit code, per Indian GSTIN jurisdiction list.
const GST_STATE_CODES = {
  "01": "Jammu & Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra & Nagar Haveli and Daman & Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman & Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh",
  "97": "Other Territory",
  "99": "Other Country"
};

const STATE_NAME_TO_CODE = {};
Object.entries(GST_STATE_CODES).forEach(([code, name]) => {
  STATE_NAME_TO_CODE[name.trim().toLowerCase()] = code;
});

function getStateCodeFromName(stateName) {
  if (!stateName) return null;
  const key = stateName.toString().trim().toLowerCase();
  return STATE_NAME_TO_CODE[key] || null;
}

// 2-digit GST jurisdiction code -> short state abbreviation (e.g. for GSTIN-derived Tally column suffixes)
const GST_STATE_ABBR = {
  "01": "JK", "02": "HP", "03": "PB", "04": "CG", "05": "UK",
  "06": "HR", "07": "DL", "08": "RJ", "09": "UP", "10": "BR",
  "11": "SK", "12": "AR", "13": "NL", "14": "MN", "15": "MZ",
  "16": "TR", "17": "MG", "18": "AS", "19": "WB", "20": "JH",
  "21": "OR", "22": "CH", "23": "MP", "24": "GJ", "26": "DN",
  "27": "MH", "29": "KA", "30": "GA", "31": "LD", "32": "KL",
  "33": "TN", "34": "PY", "35": "AN", "36": "TS", "37": "AP",
  "38": "LA", "97": "OT", "99": "OC"
};

function getStateAbbr(code) {
  if (!code) return null;
  return GST_STATE_ABBR[String(code).trim()] || null;
}

module.exports = {
  GST_STATE_CODES,
  getStateCodeFromName,
  GST_STATE_ABBR,
  getStateAbbr
};
