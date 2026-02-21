import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  Upload, 
  FileText, 
  Download, 
  Trash2, 
  Loader2, 
  Table as TableIcon, 
  Code,
  CheckCircle2,
  AlertCircle,
  FileSpreadsheet,
  RefreshCw
} from 'lucide-react';
import Papa from 'papaparse';
import { extractDataFromFiles } from './services/geminiService';
import { cn } from './lib/utils';

interface ExtractedData {
  Name: string;
  Item_Online_DisplayName: string;
  Variation_Name: string;
  Price: string;
  Category: string;
  Category_Online_DisplayName: string;
  Short_Code: string;
  Short_Code_2: string;
  Description: string;
  Attributes: string;
  Goods_Services: string;
}

const COLUMNS = [
  "Name", "Item_Online_DisplayName", "Variation_Name", "Price", 
  "Category", "Category_Online_DisplayName", "Short_Code", 
  "Short_Code_2", "Description", "Attributes", "Goods_Services"
];

const PYTHON_CODE = `import os
import re
import pandas as pd
import pytesseract
import pdfplumber
from PIL import Image
from datetime import datetime

# Requirements: pip install pytesseract pdfplumber pandas Pillow
# Note: You must have Tesseract OCR installed on your system.

class DocExtractor:
    def __init__(self):
        self.columns = [
            "Name", "Item_Online_DisplayName", "Variation_Name", "Price", 
            "Category", "Category_Online_DisplayName", "Short_Code", 
            "Short_Code_2", "Description", "Attributes", "Goods_Services"
        ]
        
    def extract_from_pdf(self, pdf_path):
        text = ""
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                text += page.extract_text() or ""
        return text

    def extract_from_image(self, img_path):
        return pytesseract.image_to_string(Image.open(img_path))

    def parse_text(self, text):
        data = []
        lines = [l.strip() for l in text.split('\\n') if l.strip()]
        price_pattern = r'(\$?\\s?\\d+[.,]\\d{2})'
        variation_keywords = ['small', 'medium', 'large', 'xl', 'red', 'blue', 'green', 'black', 'white', 'half', 'full']
        dietary_keywords = ['veg', 'non-veg', 'egg', 'chicken', 'paneer', 'mutton', 'fish', 'prawns', 'soya']
        temp_items = {} 

        for i, line in enumerate(lines):
            price_match = re.search(price_pattern, line)
            if price_match:
                price = price_match.group(1).strip()
                remaining_text = line.replace(price, "").strip()
                
                dietary_prefix = ""
                for diet in dietary_keywords:
                    if re.search(rf'\\b{diet}\\b', remaining_text, re.IGNORECASE):
                        dietary_prefix = diet.capitalize()
                        break

                found_var = ""
                for var in variation_keywords:
                    if re.search(rf'\\b{var}\\b', remaining_text, re.IGNORECASE):
                        found_var = var.capitalize()
                        remaining_text = re.sub(rf'\\b{var}\\b', '', remaining_text, flags=re.IGNORECASE).strip()
                        break
                
                base_name = remaining_text.strip(', ').strip()
                if not base_name and i > 0:
                    prev_line = lines[i-1]
                    if not re.search(price_pattern, prev_line):
                        base_name = prev_line[:50]
                
                if base_name:
                    if dietary_prefix:
                        if dietary_prefix.lower() not in base_name.lower():
                            base_name = f"{dietary_prefix} {base_name}"
                    if base_name not in temp_items: temp_items[base_name] = []
                    temp_items[base_name].append({"variation": found_var, "price": price, "line": line})

        for base_name, variations in temp_items.items():
            if len(variations) > 1:
                parent = {col: "" for col in self.columns}
                parent["Name"] = base_name
                parent["Item_Online_DisplayName"] = base_name
                parent["Price"] = "0"
                parent["Goods_Services"] = "Goods"
                data.append(parent)
                for v in variations:
                    child = {col: "" for col in self.columns}
                    child["Name"] = base_name
                    child["Item_Online_DisplayName"] = base_name
                    child["Variation_Name"] = v["variation"]
                    child["Price"] = v["price"]
                    child["Description"] = v["line"]
                    child["Goods_Services"] = "Goods"
                    data.append(child)
            else:
                v = variations[0]
                row = {col: "" for col in self.columns}
                row["Name"] = base_name
                row["Item_Online_DisplayName"] = base_name
                row["Variation_Name"] = v["variation"]
                row["Price"] = v["price"]
                row["Description"] = v["line"]
                row["Goods_Services"] = "Goods"
                data.append(row)
        return data

    def process_file(self, file_path):
        ext = os.path.splitext(file_path)[1].lower()
        try:
            if ext == '.pdf':
                text = self.extract_from_pdf(file_path)
            elif ext in ['.jpg', '.jpeg', '.png']:
                text = self.extract_from_image(file_path)
            else:
                return f"Unsupported format: {ext}"
            
            parsed_data = self.parse_text(text)
            if not parsed_data:
                return "No data identified."
                
            df = pd.DataFrame(parsed_data, columns=self.columns)
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_name = f"extracted_data_{timestamp}.csv"
            df.to_csv(output_name, index=False)
            return f"Success! Saved to {output_name}"
        except Exception as e:
            return f"Error: {str(e)}"

if __name__ == "__main__":
    import sys
    if len(sys.argv) < 2:
        print("Usage: python extractor.py <file_path>")
    else:
        extractor = DocExtractor()
        print(extractor.process_file(sys.argv[1]))
`;

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [data, setData] = useState<ExtractedData[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [activeTab, setActiveTab] = useState<'extract' | 'python'>('extract');
  const [error, setError] = useState<string | null>(null);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFiles(prev => [...prev, ...acceptedFiles]);
    setError(null);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'image/*': ['.jpeg', '.jpg', '.png'],
      'application/pdf': ['.pdf']
    }
  } as any);

  const handleExtract = async () => {
    if (files.length === 0) return;
    
    setIsExtracting(true);
    setError(null);
    try {
      const results = await extractDataFromFiles(files);
      setData(prev => [...prev, ...results]);
      setFiles([]);
    } catch (err) {
      console.error(err);
      setError("Failed to extract data. Please check your API key and file formats.");
    } finally {
      setIsExtracting(false);
    }
  };

  const downloadCSV = () => {
    const csv = Papa.unparse(data);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.setAttribute('href', url);
    link.setAttribute('download', `extracted_data_${timestamp}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const clearAll = () => {
    setData([]);
    setFiles([]);
    setError(null);
  };

  return (
    <div className="min-h-screen bg-[#F0F2F5] text-[#1A1A1A] font-sans selection:bg-blue-100 py-12 px-4">
      <div className="max-w-5xl mx-auto space-y-8">
        
        {/* Main Processing Card */}
        <div className="bg-white rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.05)] border border-zinc-200 overflow-hidden relative">
          {/* Refresh Icon */}
          <button 
            onClick={clearAll}
            className="absolute top-4 right-4 text-zinc-400 hover:text-zinc-600 transition-colors"
            title="Reset"
          >
            <RefreshCw size={18} />
          </button>

          <div className="p-8 flex flex-col items-center">
            <h1 className="text-2xl font-bold mb-8">New Menu Processing</h1>

            <div 
              {...getRootProps()} 
              className={cn(
                "w-full max-w-2xl border-2 border-dashed rounded-xl p-12 transition-all cursor-pointer flex flex-col items-center justify-center text-center gap-4",
                isDragActive ? "border-blue-500 bg-blue-50/30" : "border-zinc-200 hover:border-zinc-300 bg-white"
              )}
            >
              <input {...getInputProps()} />
              <Upload className="text-zinc-400" size={48} strokeWidth={1.5} />
              <div className="space-y-1">
                <p className="text-sm font-medium text-zinc-600">Upload Client New Menu</p>
                <p className="text-xs text-zinc-400">Drop your files here or click to browse</p>
              </div>
            </div>

            {files.length > 0 && (
              <div className="mt-4 w-full max-w-2xl">
                <div className="flex flex-wrap gap-2 justify-center">
                  {files.map((file, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-zinc-100 rounded-full text-[10px] font-medium text-zinc-600 border border-zinc-200">
                      <FileText size={12} />
                      {file.name}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="mt-10">
              <button 
                onClick={handleExtract}
                disabled={isExtracting || files.length === 0}
                className="px-10 py-3 bg-[#9BA3AF] hover:bg-[#868E99] disabled:opacity-50 text-white rounded-lg font-semibold transition-all shadow-sm"
              >
                {isExtracting ? (
                  <div className="flex items-center gap-2">
                    <Loader2 className="animate-spin" size={18} />
                    Processing...
                  </div>
                ) : (
                  'Process Files'
                )}
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="bg-red-50 border border-red-100 p-4 rounded-xl flex items-center justify-center gap-3 text-red-600 text-sm">
            <AlertCircle size={18} />
            {error}
          </div>
        )}

        {/* Results Section */}
        {data.length > 0 && (
          <div className="bg-white rounded-xl shadow-[0_2px_10px_rgba(0,0,0,0.05)] border border-zinc-200 overflow-hidden animate-in fade-in slide-in-from-bottom-4 duration-500">
            <div className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between bg-zinc-50/30">
              <div className="flex items-center gap-2">
                <TableIcon size={18} className="text-zinc-400" />
                <h2 className="text-sm font-semibold">Extracted Data ({data.length} items)</h2>
              </div>
              <button 
                onClick={downloadCSV}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-zinc-200 hover:border-blue-500 hover:text-blue-600 rounded-lg text-xs font-medium transition-all shadow-sm"
              >
                <Download size={14} />
                Download CSV
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-zinc-50/50 border-b border-zinc-100">
                    {COLUMNS.map(col => (
                      <th key={col} className="px-4 py-3 text-[10px] font-bold text-zinc-400 uppercase tracking-wider whitespace-nowrap">
                        {col.replace(/_/g, ' ')}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-100">
                  {data.map((row, i) => (
                    <tr key={i} className="hover:bg-zinc-50/30 transition-colors">
                      {COLUMNS.map(col => (
                        <td key={col} className="px-4 py-3 text-xs text-zinc-600 whitespace-nowrap max-w-[200px] truncate">
                          {row[col as keyof ExtractedData] || ''}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
