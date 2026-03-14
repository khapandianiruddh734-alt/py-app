import os
import re
import pandas as pd
import pytesseract
import pdfplumber
from PIL import Image
from datetime import datetime

# Requirements: pip install pytesseract pdfplumber pandas Pillow
# Note: You must have Tesseract OCR installed on your system for image extraction.

class DocExtractor:
    """
    A modular document extractor that maps various document types 
    to a standardized 11-column format.
    """
    def __init__(self):
        self.columns = [
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
            "Goods_Services"
        ]
        
    def extract_from_pdf(self, pdf_path):
        """Extracts raw text from a PDF file."""
        text = ""
        try:
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    text += page.extract_text() or ""
        except Exception as e:
            print(f"Error reading PDF: {e}")
        return text

    def extract_from_image(self, img_path):
        """Extracts text from an image using OCR."""
        try:
            return pytesseract.image_to_string(Image.open(img_path))
        except Exception as e:
            print(f"Error reading image: {e}")
            return ""

    def parse_text(self, text):
        """
        Enhanced parsing logic to handle diverse document patterns and variations.
        Creates parent rows with 0 price for items with variations.
        """
        data = []
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        
        # Common patterns
        price_pattern = r'(\$?\s?\d+[.,]\d{2})'
        variation_keywords = ['small', 'medium', 'large', 'xl', 'red', 'blue', 'green', 'black', 'white', 'half', 'full']
        dietary_keywords = ['veg', 'non-veg', 'egg', 'chicken', 'paneer', 'mutton', 'fish', 'prawns', 'soya']
        
        # Grouping items to detect variations
        temp_items = {} # {base_name: [list_of_variations]}

        for i, line in enumerate(lines):
            price_match = re.search(price_pattern, line)
            if price_match:
                price = price_match.group(1).strip()
                remaining_text = line.replace(price, "").strip()
                
                # Detect dietary/protein prefix (Special Rule)
                dietary_prefix = ""
                for diet in dietary_keywords:
                    if re.search(rf'\b{diet}\b', remaining_text, re.IGNORECASE):
                        dietary_prefix = diet.capitalize()
                        # We don't remove it from remaining_text because we want it in the Name
                        break

                # Detect variation (Size/Color)
                found_var = ""
                for var in variation_keywords:
                    if re.search(rf'\b{var}\b', remaining_text, re.IGNORECASE):
                        found_var = var.capitalize()
                        remaining_text = re.sub(rf'\b{var}\b', '', remaining_text, flags=re.IGNORECASE).strip()
                        break
                
                base_name = remaining_text.strip(', ').strip()
                if not base_name and i > 0:
                    prev_line = lines[i-1]
                    if not re.search(price_pattern, prev_line):
                        base_name = prev_line[:50]
                
                if base_name:
                    # If it's a dietary option, we treat it as a unique base name
                    if dietary_prefix:
                        # Ensure the prefix is in the name if not already there
                        if dietary_prefix.lower() not in base_name.lower():
                            base_name = f"{dietary_prefix} {base_name}"
                        
                    if base_name not in temp_items:
                        temp_items[base_name] = []
                    temp_items[base_name].append({
                        "variation": found_var,
                        "price": price,
                        "line": line
                    })

        # Process grouped items into final format
        for base_name, variations in temp_items.items():
            if len(variations) > 1:
                # Create PARENT row
                parent = {col: "" for col in self.columns}
                parent["Name"] = base_name
                parent["Item_Online_DisplayName"] = base_name
                parent["Price"] = "0"
                parent["Goods_Services"] = "Services"
                data.append(parent)
                
                # Create CHILD rows
                for v in variations:
                    child = {col: "" for col in self.columns}
                    child["Name"] = base_name
                    child["Item_Online_DisplayName"] = base_name
                    child["Variation_Name"] = v["variation"]
                    child["Price"] = v["price"]
                    child["Description"] = v["line"]
                    child["Goods_Services"] = "Services"
                    data.append(child)
            else:
                # Single item, no parent needed
                v = variations[0]
                row = {col: "" for col in self.columns}
                row["Name"] = base_name
                row["Item_Online_DisplayName"] = base_name
                row["Variation_Name"] = v["variation"]
                row["Price"] = v["price"]
                row["Description"] = v["line"]
                row["Goods_Services"] = "Services"
                data.append(row)
                
        return data

    def process_file(self, file_path):
        """Main entry point for processing a file."""
        if not os.path.exists(file_path):
            return f"Error: File {file_path} not found."

        ext = os.path.splitext(file_path)[1].lower()
        
        if ext == '.pdf':
            text = self.extract_from_pdf(file_path)
        elif ext in ['.jpg', '.jpeg', '.png']:
            text = self.extract_from_image(file_path)
        else:
            return f"Error: Unsupported file format {ext}."
        
        if not text.strip():
            return "Error: No text could be extracted from the file."

        parsed_data = self.parse_text(text)
        
        if not parsed_data:
            return "No structured data could be identified in the document."
            
        # Create DataFrame and save to CSV/Excel
        df = pd.DataFrame(parsed_data, columns=self.columns)
        
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        output_filename = f"extracted_data_{timestamp}.csv"
        
        df.to_csv(output_filename, index=False)
        return f"Successfully extracted {len(parsed_data)} items to {output_filename}"

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python extractor.py <path_to_document>")
    else:
        extractor = DocExtractor()
        result = extractor.process_file(sys.argv[1])
        print(result)
