import fs from "node:fs";
import path from "node:path";
import type { Page } from "@browserbasehq/stagehand";
import type { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api.js";
import type { AgentArtifact } from "../shared/agentPayload.js";
import { createConvexBlobStore } from "../profile-store/convexBlobStore.js";

type CdpCapablePage = {
  sendCDP: <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;
};

function guessContentType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  switch (ext) {
    case ".pdf":
      return "application/pdf";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".txt":
      return "text/plain";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}

export class DownloadCollector {
  readonly downloadDir: string;
  private baseline: Set<string>;
  private configured = false;

  constructor(baseDir: string) {
    this.downloadDir = path.join(baseDir, "downloads");
    fs.mkdirSync(this.downloadDir, { recursive: true });
    this.baseline = new Set(this.listFiles());
  }

  private listFiles(): string[] {
    if (!fs.existsSync(this.downloadDir)) return [];
    return fs
      .readdirSync(this.downloadDir)
      .filter((name) => !name.endsWith(".crdownload"))
      .map((name) => path.join(this.downloadDir, name));
  }

  async configure(page: Page): Promise<void> {
    if (this.configured) return;
    const cdpPage = page as unknown as CdpCapablePage;
    await cdpPage.sendCDP("Browser.setDownloadBehavior", {
      behavior: "allow",
      downloadPath: this.downloadDir,
      eventsEnabled: true,
    });
    this.configured = true;
  }

  /** Wait briefly for in-progress downloads to finish. */
  async waitForDownloads(timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = fs.readdirSync(this.downloadDir).some((name) => name.endsWith(".crdownload"));
      if (!pending) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  newFiles(): string[] {
    const current = this.listFiles();
    return current.filter((file) => !this.baseline.has(file));
  }
}

export async function uploadArtifacts(opts: {
  convex: ConvexHttpClient;
  workerKey: string;
  files: string[];
}): Promise<AgentArtifact[]> {
  if (opts.files.length === 0) return [];

  const blobStore = createConvexBlobStore(opts.convex, opts.workerKey);
  const artifacts: AgentArtifact[] = [];

  for (const filePath of opts.files) {
    const data = fs.readFileSync(filePath);
    const name = path.basename(filePath);
    const contentType = guessContentType(name);
    const uploadUrl = await opts.convex.mutation(api.snapshots.generateUploadUrl, {
      workerKey: opts.workerKey,
    });
    const res = await fetch(uploadUrl, {
      method: "POST",
      headers: { "Content-Type": contentType },
      body: new Uint8Array(data),
    });
    if (!res.ok) throw new Error(`artifact upload failed: HTTP ${res.status}`);
    const { storageId } = (await res.json()) as { storageId: string };
    const url = await blobStore.getUrl(storageId);
    artifacts.push({
      name,
      contentType,
      sizeBytes: data.byteLength,
      storageId,
      url,
    });
  }

  return artifacts;
}
