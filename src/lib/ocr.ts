import { createWorker, OEM, type LoggerMessage } from "tesseract.js";
import { api } from "./bridge";
import type { OcrResult } from "../types";

export type OcrProgress = (progress: number, label: string) => void;

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "tif", "tiff", "bmp"]);

function bytesToUrl(bytes: number[], mime: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  return URL.createObjectURL(blob);
}

async function pdfPages(relativePath: string, onProgress: OcrProgress) {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/ocr/pdf.worker.min.mjs";
  const bytes = new Uint8Array(await api.readFileBytes(relativePath));
  const pdfDocument = await pdfjs.getDocument({ data: bytes }).promise;
  const pages: string[] = [];
  const pageLimit = Math.min(pdfDocument.numPages, 50);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    onProgress((pageNumber - 1) / pageLimit * 0.18, `正在准备第 ${pageNumber}/${pageLimit} 页`);
    const page = await pdfDocument.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) throw new Error("无法创建 PDF 页面画布");
    await page.render({ canvasContext: context, viewport, canvas }).promise;
    pages.push(canvas.toDataURL("image/png"));
  }
  return pages;
}

export interface OCRProvider {
  readonly id: string;
  readonly name: string;
  supports(extension: string): boolean;
  recognize(relativePath: string, onProgress: OcrProgress): Promise<OcrResult>;
}

export class LocalOcrProvider implements OCRProvider {
  readonly id = "local-offline";
  readonly name = "本地离线 OCR";

  supports(extension: string) {
    const ext = extension.toLowerCase().replace(".", "");
    return IMAGE_EXTENSIONS.has(ext) || ext === "pdf";
  }

  async recognize(relativePath: string, onProgress: OcrProgress): Promise<OcrResult> {
    const cached = await api.getCachedOcr(relativePath);
    const fingerprint = await api.getFileHash(relativePath);
    if (cached && (cached as OcrResult & { fingerprint?: string }).fingerprint === fingerprint) {
      onProgress(1, "已读取本地识别缓存");
      return { ...cached, cached: true };
    }

    const extension = relativePath.split(".").pop()?.toLowerCase() ?? "";
    if (!this.supports(extension)) throw new Error("当前文件类型不支持 OCR");

    let latestMessage = "正在加载离线识别引擎";
    const worker = await createWorker(["chi_sim", "eng"], OEM.LSTM_ONLY, {
      langPath: "/ocr",
      workerPath: "/ocr/worker.min.js",
      corePath: "/ocr/tesseract-core-simd-lstm.wasm.js",
      gzip: true,
      logger: (message: LoggerMessage) => {
        latestMessage = message.status === "recognizing text" ? "正在识别文字" : "正在准备识别引擎";
        if (typeof message.progress === "number") onProgress(Math.min(0.98, message.progress), latestMessage);
      },
    });

    const objectUrls: string[] = [];
    try {
      const sources = extension === "pdf"
        ? await pdfPages(relativePath, onProgress)
        : [bytesToUrl(await api.readFileBytes(relativePath), `image/${extension === "jpg" ? "jpeg" : extension}`)];
      if (extension !== "pdf") objectUrls.push(...sources);

      const blocks: string[] = [];
      let confidence = 0;
      for (let index = 0; index < sources.length; index += 1) {
        const pageBase = index / sources.length;
        onProgress(pageBase, `正在识别第 ${index + 1}/${sources.length} 页`);
        const response = await worker.recognize(sources[index]);
        blocks.push(response.data.text.trim());
        confidence += response.data.confidence;
      }

      const result: OcrResult & { fingerprint: string } = {
        relativePath,
        text: blocks.filter(Boolean).join("\n\n—— 第下一页 ——\n\n"),
        confidence: sources.length ? confidence / sources.length : 0,
        pages: sources.length,
        languages: ["chi_sim", "eng"],
        cached: false,
        fingerprint,
      };
      await api.saveOcrResult(result);
      onProgress(1, "识别完成，已加入本地搜索索引");
      return result;
    } finally {
      objectUrls.forEach(URL.revokeObjectURL);
      await worker.terminate();
    }
  }
}

export const localOcr = new LocalOcrProvider();
