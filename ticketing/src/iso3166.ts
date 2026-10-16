// iso 3166-1 alpha-2: the full set of officially assigned codes.
// markets and territories in internal data are always one of these.
// "uk" is not here on purpose: gb is the assigned code; uk is only
// exceptionally reserved.

export const ISO_3166_1_ALPHA_2: ReadonlySet<string> = new Set([
  "AD","AE","AF","AG","AI","AL","AM","AO","AQ","AR",
  "AS","AT","AU","AW","AX","AZ","BA","BB","BD","BE",
  "BF","BG","BH","BI","BJ","BL","BM","BN","BO","BQ",
  "BR","BS","BT","BV","BW","BY","BZ","CA","CC","CD",
  "CF","CG","CH","CI","CK","CL","CM","CN","CO","CR",
  "CU","CV","CW","CX","CY","CZ","DE","DJ","DK","DM",
  "DO","DZ","EC","EE","EG","EH","ER","ES","ET","FI",
  "FJ","FK","FM","FO","FR","GA","GB","GD","GE","GF",
  "GG","GH","GI","GL","GM","GN","GP","GQ","GR","GS",
  "GT","GU","GW","GY","HK","HM","HN","HR","HT","HU",
  "ID","IE","IL","IM","IN","IO","IQ","IR","IS","IT",
  "JE","JM","JO","JP","KE","KG","KH","KI","KM","KN",
  "KP","KR","KW","KY","KZ","LA","LB","LC","LI","LK",
  "LR","LS","LT","LU","LV","LY","MA","MC","MD","ME",
  "MF","MG","MH","MK","ML","MM","MN","MO","MP","MQ",
  "MR","MS","MT","MU","MV","MW","MX","MY","MZ","NA",
  "NC","NE","NF","NG","NI","NL","NO","NP","NR","NU",
  "NZ","OM","PA","PE","PF","PG","PH","PK","PL","PM",
  "PN","PR","PS","PT","PW","PY","QA","RE","RO","RS",
  "RU","RW","SA","SB","SC","SD","SE","SG","SH","SI",
  "SJ","SK","SL","SM","SN","SO","SR","SS","ST","SV",
  "SX","SY","SZ","TC","TD","TF","TG","TH","TJ","TK",
  "TL","TM","TN","TO","TR","TT","TV","TW","TZ","UA",
  "UG","UM","US","UY","UZ","VA","VC","VE","VG","VI",
  "VN","VU","WF","WS","YE","YT","ZA","ZM","ZW",
].filter((code) => code !== ""));

export class MarketError extends Error {}

export function isMarket(code: string): boolean {
  return /^[A-Z]{2}$/.test(code) && ISO_3166_1_ALPHA_2.has(code);
}

export function assertMarket(code: string): void {
  if (!isMarket(code)) {
    throw new MarketError(`"${code}" is not an iso 3166-1 alpha-2 code`);
  }
}

export class LanguageError extends Error {}

// light bcp-47 shape check; full validation is not the core's job
export function assertLanguage(language: string): void {
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new LanguageError(`"${language}" is not a bcp-47 language tag`);
  }
}
