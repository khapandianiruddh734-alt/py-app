import { GoogleGenAI, Type } from "@google/genai";

const COLUMNS = [
  "Name",
  "Item_Online_DisplayName",
  "Variation_Name",
  "Price",
  "Category",
  "Category_Online_DisplayName",
  "Short_Code",
  "Short_Code_2",
  "Description",
  "Attributes",
  "Goods_Services",
] as const;

type ExtractedRow = Record<(typeof COLUMNS)[number], string>;
export type ExtractionLanguage =
  | "auto"
  | "english"
  | "hindi"
  | "arabic"
  | "urdu"
  | "bengali"
  | "tamil"
  | "telugu"
  | "marathi"
  | "gujarati"
  | "punjabi"
  | "malayalam"
  | "kannada"
  | "french"
  | "spanish";
export type OutputMode = "structured" | "original";

const CACHE_PREFIX = "docuextract:rows:v1";
const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days
const memoryCache = new Map<string, ExtractedRow[]>();

const COLUMN_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      Name: { type: Type.STRING },
      Item_Online_DisplayName: { type: Type.STRING },
      Variation_Name: { type: Type.STRING },
      Price: { type: Type.STRING },
      Category: { type: Type.STRING },
      Category_Online_DisplayName: { type: Type.STRING },
      Short_Code: { type: Type.STRING },
      Short_Code_2: { type: Type.STRING },
      Description: { type: Type.STRING },
      Attributes: { type: Type.STRING },
      Goods_Services: { type: Type.STRING },
    },
    required: ["Name", "Price"],
  },
};

interface ExtractOptions {
  language: ExtractionLanguage;
  outputMode: OutputMode;
}

const LANGUAGE_INSTRUCTIONS: Record<ExtractionLanguage, string> = {
  auto:
    "Detect the source language automatically. Do not translate item text unless required for readability in target columns.",
  english:
    "Prioritize English text if multilingual content exists. Keep original wording and transliterate only when the source has no English form.",
  hindi:
    "Prioritize Hindi (Devanagari) text. Keep Hindi spelling as the source language when available.",
  arabic:
    "Prioritize Arabic text. Keep Arabic spelling as the source language when available.",
  urdu:
    "Prioritize Urdu text. Keep Urdu spelling as the source language when available.",
  bengali:
    "Prioritize Bengali text. Keep Bengali spelling as the source language when available.",
  tamil:
    "Prioritize Tamil text. Keep Tamil spelling as the source language when available.",
  telugu:
    "Prioritize Telugu text. Keep Telugu spelling as the source language when available.",
  marathi:
    "Prioritize Marathi text. Keep Marathi spelling as the source language when available.",
  gujarati:
    "Prioritize Gujarati text. Keep Gujarati spelling as the source language when available.",
  punjabi:
    "Prioritize Punjabi text. Keep Punjabi spelling as the source language when available.",
  malayalam:
    "Prioritize Malayalam text. Keep Malayalam spelling as the source language when available.",
  kannada:
    "Prioritize Kannada text. Keep Kannada spelling as the source language when available.",
  french:
    "Prioritize French text. Keep original French wording and avoid translation where possible.",
  spanish:
    "Prioritize Spanish text. Keep original Spanish wording and avoid translation where possible.",
};

const DIETARY_PREFIXES = [
  "veg",
  "non-veg",
  "egg",
  "chicken",
  "paneer",
  "prawns",
  "fish",
  "mutton",
  "soya",
];

function buildExtractionPrompt(options: ExtractOptions) {
  if (options.outputMode === "original") {
    return `Extract all line items from this document into JSON rows using the exact column list below.

STRICT COLUMN FORMAT:
- Name
- Item_Online_DisplayName
- Variation_Name
- Price
- Category
- Category_Online_DisplayName
- Short_Code
- Short_Code_2
- Description
- Attributes
- Goods_Services

LANGUAGE MODE:
- ${LANGUAGE_INSTRUCTIONS[options.language]}

ORIGINAL OUTPUT MODE:
- Preserve original source order exactly.
- Preserve original text formatting, spelling, punctuation, and casing.
- Do not normalize or rewrite product names.
- Do not create synthetic parent/child rows unless that structure is explicitly shown in the source.
- Keep each extracted source line as close as possible in Description.
- If a field is missing, return an empty string.
- Make sure to assign proper attributes to the items, specifically ensuring 'veg', 'non-veg', and 'egg' attributes are added.
- Always put 'Services' in the Goods_Services column for all items.
- Make sure that do not make any changes in the existing code (Short_Code / Short_Code_2).
- If dietary terms (Veg, Non-Veg, Chicken, Paneer, Prawns, Egg, etc.) are given as options/variations, prefix the Name with that term (e.g., "Veg Manchurian", "Chicken Momos"). Do not reorder existing names unless adding that prefix.
- Output only a valid JSON array.`;
  }

  return `Extract all line items from this document into a structured JSON format.

STRICT COLUMN FORMAT:
- Name
- Item_Online_DisplayName
- Variation_Name
- Price
- Category
- Category_Online_DisplayName
- Short_Code
- Short_Code_2
- Description
- Attributes
- Goods_Services

LANGUAGE MODE:
- ${LANGUAGE_INSTRUCTIONS[options.language]}

VARIATION HANDLING RULES:
1. If an item has portion sizes (e.g., "Half", "Full") or standard variations (e.g., "Small", "Large", "Red"):
   - Create a PARENT row first.
   - For the PARENT row: Set 'Price' to "0", 'Variation_Name' to empty, and 'Name' to the base product name.
   - Then create CHILD rows for each variation immediately below the parent.
   - For CHILD rows: Set 'Name' to the base product name, 'Variation_Name' to the specific variation (e.g., "Half", "Full"), and 'Price' to the actual price.
2. SPECIAL RULE FOR DIETARY/PROTEIN OPTIONS (Veg, Non-Veg, Egg, Chicken, Paneer, Soya, etc.):
   - DO NOT create a parent-child variation structure for these categories themselves.
   - Instead, include the dietary type in the standalone 'Name'.
   - If these standalone items have portion sizes (Half/Full), then apply Rule 1 to that specific item.
   - Example: "Veg Steam Momos" (Parent, Price 0) -> "Veg Steam Momos" (Child, Variation: Half, Price: 60) -> "Veg Steam Momos" (Child, Variation: Full, Price: 100).
3. If an item has no variations, just create a single row with its actual price.
4. If a product line contains "/" between item names (example: "Cheese / Kashmiri Naan"):
   - Split into separate rows for each item name.
   - If prices are also slash-separated (example: "120/160"), map each price to the matching item in order.
   - Example output rows: "Cheese Naan" (120) and "Kashmiri Naan" (160).
5. Do not keep slash-combined names or variations in one row.
   - If Name, Item_Online_DisplayName, or Variation_Name contains slash-separated alternatives, create separate rows.

ORDERING RULE:
- Preserve the original top-to-bottom line sequence from the source document.
- Do not sort or regroup rows.

MAPPING INTELLIGENCE:
- 'Name' is the primary product/service name.
- 'Item_Online_DisplayName' should usually match 'Name' unless a specific online name is found.
- 'Attributes' should contain any extra details like SKU, weight, or technical specs. Make sure to assign proper attributes to the items, specifically ensuring 'veg', 'non-veg', and 'egg' attributes are included.
- 'Goods_Services' MUST always be "Services". Always put "Services" in this column for every item.
- 'Short_Code' and 'Short_Code_2': Make sure that do not make any changes in the existing code.
- If dietary terms (Veg, Non-Veg, Chicken, Paneer, Prawns, Egg, etc.) are given as options/variations, prefix the Name with that term (e.g., "Veg Manchurian", "Chicken Momos"). Do not reorder existing names unless adding that prefix.
- Output only a valid JSON array.`;
}

export async function extractDataFromFiles(files: File[], options: ExtractOptions) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = "gemini-3-flash-preview";

  const results: any[] = [];

  for (const file of files) {
    const cacheKey = await buildCacheKey(file, options);
    const cachedRows = readCache(cacheKey);
    if (cachedRows) {
      results.push(...cachedRows);
      continue;
    }

    const base64Data = await fileToBase64(file);
    const mimeType = file.type;

    const response = await ai.models.generateContent({
      model,
      contents: [
        {
          parts: [
            {
              inlineData: {
                data: base64Data.split(",")[1],
                mimeType: mimeType,
              },
            },
            {
              text: buildExtractionPrompt(options),
            },
          ],
        },
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: COLUMN_SCHEMA,
      },
    });

    try {
      const parsed = JSON.parse(response.text || "[]");
      const normalizedRows = (Array.isArray(parsed) ? parsed : []).map((row: any) =>
        COLUMNS.reduce((acc, col) => {
          acc[col] = row?.[col] != null ? String(row[col]) : "";
          return acc;
        }, {} as ExtractedRow)
      );
      const finalRows =
        options.outputMode === "structured"
          ? ensureDietaryPrefixAtStart(expandSlashSeparatedRows(normalizedRows))
          : normalizedRows;
      writeCache(cacheKey, finalRows);
      results.push(...finalRows);
    } catch (e) {
      console.error("Failed to parse Gemini response", e);
    }
  }

  return results;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });
}

function expandSlashSeparatedRows(rows: ExtractedRow[]): ExtractedRow[] {
  const expanded: ExtractedRow[] = [];

  for (const row of rows) {
    const shouldSplit =
      hasMeaningfulSlash(row.Name) ||
      hasMeaningfulSlash(row.Item_Online_DisplayName) ||
      hasMeaningfulSlash(row.Variation_Name);

    if (!shouldSplit) {
      expanded.push(row);
      continue;
    }

    const nameParts = splitSlashText(row.Name);
    const displayNameParts = splitSlashText(row.Item_Online_DisplayName);
    const variationParts = splitSlashText(row.Variation_Name);
    const priceParts = splitSlashPrices(row.Price);

    const splitCount = Math.max(
      nameParts.length,
      displayNameParts.length,
      variationParts.length,
      priceParts.length
    );

    if (splitCount < 2) {
      expanded.push(row);
      continue;
    }

    const normalizedNames = normalizeSlashNames(
      nameParts.length === splitCount ? nameParts : [row.Name]
    );
    const normalizedDisplayNames =
      displayNameParts.length === splitCount
        ? normalizeSlashNames(displayNameParts)
        : [];
    const normalizedVariations =
      variationParts.length === splitCount ? variationParts : [];

    for (let index = 0; index < splitCount; index += 1) {
      const name = normalizedNames[index] ?? row.Name;
      const displayName = normalizedDisplayNames[index] ?? name;
      const variation = normalizedVariations[index] ?? row.Variation_Name;
      expanded.push({
        ...row,
        Name: name,
        Item_Online_DisplayName: displayName,
        Variation_Name: variation,
        Price: priceParts[index] ?? row.Price,
      });
    }
  }

  return expanded;
}

function ensureDietaryPrefixAtStart(rows: ExtractedRow[]): ExtractedRow[] {
  return rows.map((row) => {
    const dietaryPrefix = normalizeDietaryPrefix(row.Variation_Name);
    if (!dietaryPrefix) {
      return row;
    }

    const name = String(row.Name || "").trim();
    if (!name) {
      return row;
    }

    if (name.toLowerCase().startsWith(`${dietaryPrefix.toLowerCase()} `)) {
      return row;
    }

    return {
      ...row,
      Name: `${dietaryPrefix} ${name}`.trim(),
      Item_Online_DisplayName: `${dietaryPrefix} ${row.Item_Online_DisplayName || name}`.trim(),
    };
  });
}

function normalizeDietaryPrefix(value: string): string | null {
  const token = String(value || "").trim().toLowerCase();
  if (!token) {
    return null;
  }
  return DIETARY_PREFIXES.includes(token) ? capitalizeWord(token) : null;
}

function capitalizeWord(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function splitSlashPrices(price: string): string[] {
  const parts = String(price || "")
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length >= 2 ? parts : [];
}

function normalizeSlashNames(parts: string[]): string[] {
  const cleaned = parts.map((part) => part.replace(/\s+/g, " ").trim());
  const last = cleaned[cleaned.length - 1];
  const lastWords = last.split(" ").filter(Boolean);
  const sharedSuffix = lastWords.length > 1 ? lastWords[lastWords.length - 1] : "";

  return cleaned.map((part, index) => {
    if (!sharedSuffix || index === cleaned.length - 1) {
      return part;
    }

    const words = part.split(" ").filter(Boolean);
    if (words.length === 1) {
      return `${part} ${sharedSuffix}`.trim();
    }
    return part;
  });
}

function hasMeaningfulSlash(value: string): boolean {
  const text = String(value || "").trim();
  if (!text || !text.includes("/")) {
    return false;
  }
  return /\p{L}\s*\/\s*\p{L}/u.test(text);
}

function splitSlashText(value: string): string[] {
  return String(value || "")
    .split(/\s*\/\s*/g)
    .map((part) => part.trim())
    .filter(Boolean);
}

interface CachedRowsPayload {
  createdAt: number;
  rows: ExtractedRow[];
}

function readCache(cacheKey: string): ExtractedRow[] | null {
  const fromMemory = memoryCache.get(cacheKey);
  if (fromMemory) {
    return fromMemory;
  }

  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(cacheKey);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as CachedRowsPayload;
    if (
      !parsed ||
      typeof parsed.createdAt !== "number" ||
      !Array.isArray(parsed.rows)
    ) {
      window.localStorage.removeItem(cacheKey);
      return null;
    }

    if (Date.now() - parsed.createdAt > CACHE_TTL_MS) {
      window.localStorage.removeItem(cacheKey);
      return null;
    }

    memoryCache.set(cacheKey, parsed.rows);
    return parsed.rows;
  } catch {
    return null;
  }
}

function writeCache(cacheKey: string, rows: ExtractedRow[]) {
  memoryCache.set(cacheKey, rows);

  if (typeof window === "undefined") {
    return;
  }

  try {
    const payload: CachedRowsPayload = { createdAt: Date.now(), rows };
    window.localStorage.setItem(cacheKey, JSON.stringify(payload));
  } catch {
    // Ignore storage quota/privacy errors and continue without persistent cache.
  }
}

async function buildCacheKey(file: File, options: ExtractOptions): Promise<string> {
  const fingerprint = await getFileFingerprint(file);
  return `${CACHE_PREFIX}:${options.language}:${options.outputMode}:${fingerprint}`;
}

async function getFileFingerprint(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const hashHex = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${file.name}:${file.size}:${file.lastModified}:${hashHex}`;
}
