// Country names for the origin picker. Coffee-growing countries come first so
// they surface at the top of the suggestion list; the rest follow A–Z.
export const COFFEE_COUNTRIES = [
  'Ethiopia', 'Kenya', 'Colombia', 'Brazil', 'Guatemala', 'Costa Rica', 'Honduras',
  'El Salvador', 'Nicaragua', 'Panama', 'Peru', 'Bolivia', 'Ecuador', 'Mexico',
  'Rwanda', 'Burundi', 'Uganda', 'Tanzania', 'Democratic Republic of the Congo',
  'Yemen', 'Indonesia', 'Papua New Guinea', 'India', 'Vietnam', 'China', 'Myanmar',
  'Thailand', 'Laos', 'Timor-Leste', 'Philippines', 'Jamaica', 'Dominican Republic',
  'Haiti', 'Cuba', 'Puerto Rico', 'Malawi', 'Zambia', 'Zimbabwe', 'Cameroon',
  'Ivory Coast', 'Madagascar', 'Venezuela', 'Taiwan', 'Nepal', 'Australia',
  'United States',
];

const OTHER_COUNTRIES = [
  'Afghanistan', 'Albania', 'Algeria', 'Andorra', 'Angola', 'Argentina', 'Armenia',
  'Austria', 'Azerbaijan', 'Bahamas', 'Bahrain', 'Bangladesh', 'Barbados', 'Belarus',
  'Belgium', 'Belize', 'Benin', 'Bhutan', 'Bosnia and Herzegovina', 'Botswana',
  'Brunei', 'Bulgaria', 'Burkina Faso', 'Cambodia', 'Canada', 'Cape Verde',
  'Central African Republic', 'Chad', 'Chile', 'Comoros', 'Croatia', 'Cyprus',
  'Czechia', 'Denmark', 'Djibouti', 'Dominica', 'Egypt', 'Equatorial Guinea', 'Eritrea',
  'Estonia', 'Eswatini', 'Fiji', 'Finland', 'France', 'Gabon', 'Gambia', 'Georgia',
  'Germany', 'Ghana', 'Greece', 'Grenada', 'Guinea', 'Guinea-Bissau', 'Guyana',
  'Hungary', 'Iceland', 'Iran', 'Iraq', 'Ireland', 'Israel', 'Italy', 'Japan', 'Jordan',
  'Kazakhstan', 'Kosovo', 'Kuwait', 'Kyrgyzstan', 'Latvia', 'Lebanon', 'Lesotho',
  'Liberia', 'Libya', 'Liechtenstein', 'Lithuania', 'Luxembourg', 'Malaysia',
  'Maldives', 'Mali', 'Malta', 'Mauritania', 'Mauritius', 'Moldova', 'Monaco',
  'Mongolia', 'Montenegro', 'Morocco', 'Mozambique', 'Namibia', 'Netherlands',
  'New Zealand', 'Niger', 'Nigeria', 'North Korea', 'North Macedonia', 'Norway', 'Oman',
  'Pakistan', 'Palestine', 'Paraguay', 'Poland', 'Portugal', 'Qatar',
  'Republic of the Congo', 'Romania', 'Russia', 'Saint Helena', 'Saint Lucia',
  'Samoa', 'Saudi Arabia', 'Senegal', 'Serbia', 'Sierra Leone', 'Singapore',
  'Slovakia', 'Slovenia', 'Solomon Islands', 'Somalia', 'South Africa', 'South Korea',
  'South Sudan', 'Spain', 'Sri Lanka', 'Sudan', 'Suriname', 'Sweden', 'Switzerland',
  'Syria', 'Tajikistan', 'Togo', 'Tonga', 'Trinidad and Tobago', 'Tunisia', 'Turkey',
  'Turkmenistan', 'Ukraine', 'United Arab Emirates', 'United Kingdom', 'Uruguay',
  'Uzbekistan', 'Vanuatu', 'Zanzibar',
];

export const COUNTRIES = [...COFFEE_COUNTRIES, ...OTHER_COUNTRIES.sort()];

// Adjectives, misspellings and alternate names → canonical country.
const ALIASES = {
  ethiopian: 'Ethiopia', ethiopie: 'Ethiopia', ethiopië: 'Ethiopia',
  kenyan: 'Kenya',
  columbia: 'Colombia', colombian: 'Colombia', columbian: 'Colombia',
  brasil: 'Brazil', brazilian: 'Brazil', brazillian: 'Brazil',
  bilovia: 'Bolivia', bolivian: 'Bolivia',
  guatemalan: 'Guatemala',
  'costa rican': 'Costa Rica', costarica: 'Costa Rica',
  honduran: 'Honduras', salvador: 'El Salvador', salvadoran: 'El Salvador',
  nicaraguan: 'Nicaragua', panamanian: 'Panama', peruvian: 'Peru',
  ecuadorian: 'Ecuador', mexican: 'Mexico', rwandan: 'Rwanda', burundian: 'Burundi',
  ugandan: 'Uganda', tanzanian: 'Tanzania', yemeni: 'Yemen', indonesian: 'Indonesia',
  sumatra: 'Indonesia', java: 'Indonesia', sulawesi: 'Indonesia', bali: 'Indonesia',
  png: 'Papua New Guinea', indian: 'India', vietnamese: 'Vietnam', 'viet nam': 'Vietnam',
  chinese: 'China', yunnan: 'China', congo: 'Democratic Republic of the Congo',
  drc: 'Democratic Republic of the Congo', 'dr congo': 'Democratic Republic of the Congo',
  jamaican: 'Jamaica', "cote d'ivoire": 'Ivory Coast', 'côte d’ivoire': 'Ivory Coast',
  usa: 'United States', us: 'United States', hawaii: 'United States', kona: 'United States',
  'east timor': 'Timor-Leste', timor: 'Timor-Leste', burma: 'Myanmar',
  uk: 'United Kingdom', holland: 'Netherlands',
};

const BY_LOWER = new Map(COUNTRIES.map((c) => [c.toLowerCase(), c]));

/** Map free text to a canonical country name, or null if it isn't one. */
export function matchCountry(text) {
  const t = String(text || '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return null;
  return BY_LOWER.get(t) || ALIASES[t] || null;
}

/**
 * Split a legacy origin string ("Brazil & bilovia", "Guji, Ethiopia") into
 * canonical countries plus whatever didn't match (kept as region text).
 */
export function parseOrigin(text) {
  const parts = String(text || '')
    .split(/\s*(?:&|,|\/|\+|\band\b)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean);
  const countries = [];
  const rest = [];
  for (const p of parts) {
    const c = matchCountry(p);
    if (c) {
      if (!countries.includes(c)) countries.push(c);
    } else {
      rest.push(p);
    }
  }
  return { countries, region: rest.join(', ') };
}
