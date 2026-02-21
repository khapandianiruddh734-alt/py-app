import { GoogleGenAI, Type } from "@google/genai";

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

export async function extractDataFromFiles(files: File[]) {
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const model = "gemini-3-flash-preview";

  const results: any[] = [];

  for (const file of files) {
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
              text: `Extract all line items from this document into a structured JSON format. 
              
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
              
              MAPPING INTELLIGENCE:
              - 'Name' is the primary product/service name.
              - 'Item_Online_DisplayName' should usually match 'Name' unless a specific online name is found.
              - 'Attributes' should contain any extra details like SKU, weight, or technical specs.
              - 'Goods_Services' should be "Goods" or "Services".`,
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
      results.push(...parsed);
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
