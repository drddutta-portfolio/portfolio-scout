import * as XLSX from "@e965/xlsx";

/**
 * Browser-only spreadsheet parsing. The original file is NEVER uploaded:
 * only the parsed raw cell text and a WebCrypto SHA-256 of the bytes leave
 * the browser, and only into the M06 staging tables.
 *
 * Values are preserved exactly as the source presents them. Nothing is
 * defaulted, coerced or invented here.
 */

export type SourceFormat = "CSV" | "XLSX" | "XLS";

export interface ParsedSheet {
  name: string;
  headers: string[];
  rows: string[][];
}

export interface ParsedFile {
  fileName: string;
  format: SourceFormat;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  sheets: ParsedSheet[];
}

export function detectFormat(fileName: string): SourceFormat | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "CSV";
  if (lower.endsWith(".xlsx")) return "XLSX";
  if (lower.endsWith(".xls")) return "XLS";
  return null;
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function parseSpreadsheet(file: File): Promise<ParsedFile> {
  const format = detectFormat(file.name);
  if (!format) {
    throw new Error("Unsupported file type. Use a .csv, .xlsx or .xls file.");
  }

  const buffer = await file.arrayBuffer();
  const sha256 = await sha256Hex(buffer);

  const workbook = XLSX.read(new Uint8Array(buffer), {
    type: "array",
    raw: false,
    cellDates: false,
    cellText: true,
    codepage: 65001,
  });

  const sheets: ParsedSheet[] = [];
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const parsed = sheetToTable(sheet, sheetName);
    if (parsed) sheets.push(parsed);
  }

  if (sheets.length === 0) throw new Error("The file contains no readable rows.");

  return {
    fileName: file.name,
    format,
    mimeType: file.type || "application/octet-stream",
    sizeBytes: file.size,
    sha256,
    sheets,
  };
}

function sheetToTable(sheet: XLSX.WorkSheet, name: string): ParsedSheet | null {
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: false,
    blankrows: false,
    defval: null,
  });

  const cleaned = matrix
    .map((row) => (Array.isArray(row) ? row.map(cellToText) : []))
    .filter((row) => row.some((cell) => cell !== ""));

  if (cleaned.length === 0) return null;

  const headerRow = cleaned[0]!;
  const width = cleaned.reduce((max, row) => Math.max(max, row.length), 0);
  const headers = Array.from({ length: width }, (_, i) => {
    const value = headerRow[i] ?? "";
    return value === "" ? `Column ${i + 1}` : value;
  });

  const rows = cleaned
    .slice(1)
    .map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));

  return { name, headers, rows };
}

function cellToText(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (typeof cell === "string") return cell.trim();
  if (typeof cell === "number" || typeof cell === "boolean") return String(cell);
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  return String(cell).trim();
}
