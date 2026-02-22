import React, { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { 
  Upload, 
  FileText, 
  Download, 
  Loader2, 
  Table as TableIcon, 
  AlertCircle,
  RefreshCw
} from 'lucide-react';
import Papa from 'papaparse';
import { extractDataFromFiles, type ExtractionLanguage, type OutputMode } from './services/geminiService';
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

const COLUMNS: Array<keyof ExtractedData> = [
  "Name", "Item_Online_DisplayName", "Variation_Name", "Price", 
  "Category", "Category_Online_DisplayName", "Short_Code", 
  "Short_Code_2", "Description", "Attributes", "Goods_Services"
];

export default function App() {
  const [files, setFiles] = useState<File[]>([]);
  const [data, setData] = useState<ExtractedData[]>([]);
  const [isExtracting, setIsExtracting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [language, setLanguage] = useState<ExtractionLanguage>('auto');
  const [outputMode, setOutputMode] = useState<OutputMode>('structured');

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
      const results = await extractDataFromFiles(files, { language, outputMode });
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
    const orderedRows = data.map((row) =>
      COLUMNS.reduce((acc, col) => {
        acc[col] = row[col] || '';
        return acc;
      }, {} as ExtractedData)
    );
    const csv = Papa.unparse(orderedRows, { columns: COLUMNS as string[] });
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

            <div className="mt-6 w-full max-w-2xl grid grid-cols-1 md:grid-cols-2 gap-3">
              <label className="text-xs font-medium text-zinc-600">
                OCR / Language
                <select
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as ExtractionLanguage)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
                >
                  <option value="auto">Auto Detect</option>
                  <option value="english">English</option>
                  <option value="hindi">Hindi</option>
                  <option value="arabic">Arabic</option>
                  <option value="urdu">Urdu</option>
                  <option value="bengali">Bengali</option>
                  <option value="tamil">Tamil</option>
                  <option value="telugu">Telugu</option>
                  <option value="marathi">Marathi</option>
                  <option value="gujarati">Gujarati</option>
                  <option value="punjabi">Punjabi</option>
                  <option value="malayalam">Malayalam</option>
                  <option value="kannada">Kannada</option>
                  <option value="french">French</option>
                  <option value="spanish">Spanish</option>
                </select>
              </label>

              <label className="text-xs font-medium text-zinc-600">
                Output Format
                <select
                  value={outputMode}
                  onChange={(e) => setOutputMode(e.target.value as OutputMode)}
                  className="mt-1 w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm text-zinc-700 focus:outline-none focus:ring-2 focus:ring-blue-200"
                >
                  <option value="structured">Structured</option>
                  <option value="original">Original</option>
                </select>
              </label>
            </div>

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
                        {col}
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
